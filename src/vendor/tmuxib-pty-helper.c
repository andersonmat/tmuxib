#define _GNU_SOURCE

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t should_terminate = 0;
static pid_t child_pid = -1;
static int master_fd = -1;

static void handle_signal(int signum) {
  should_terminate = signum;
}

static void send_line(const char *text) {
  size_t length = strlen(text);
  if (write(STDOUT_FILENO, text, length) < 0) {
    // Best effort only.
  }
}

static void send_ready(void) {
  send_line("{\"type\":\"ready\"}\n");
}

static void send_error_message(const char *message) {
  send_line("{\"type\":\"error\",\"message\":\"");

  for (const unsigned char *cursor = (const unsigned char *)message; *cursor; cursor += 1) {
    unsigned char byte = *cursor;

    switch (byte) {
      case '\\':
        send_line("\\\\");
        break;
      case '"':
        send_line("\\\"");
        break;
      case '\n':
        send_line("\\n");
        break;
      case '\r':
        send_line("\\r");
        break;
      case '\t':
        send_line("\\t");
        break;
      default: {
        if (byte < 0x20) {
          char escape[7];
          snprintf(escape, sizeof(escape), "\\u%04x", byte);
          send_line(escape);
        } else {
          char literal[2] = { (char)byte, '\0' };
          send_line(literal);
        }
        break;
      }
    }
  }

  send_line("\"}\n");
}

static void send_exit_status(int status) {
  char payload[128];

  if (WIFEXITED(status)) {
    snprintf(payload, sizeof(payload), "{\"type\":\"exit\",\"exitCode\":%d,\"signal\":0}\n", WEXITSTATUS(status));
  } else if (WIFSIGNALED(status)) {
    snprintf(payload, sizeof(payload), "{\"type\":\"exit\",\"exitCode\":0,\"signal\":%d}\n", WTERMSIG(status));
  } else {
    snprintf(payload, sizeof(payload), "{\"type\":\"exit\",\"exitCode\":1,\"signal\":0}\n");
  }

  send_line(payload);
}

static void send_data(const char *data, ssize_t length) {
  send_line("{\"type\":\"data\",\"data\":\"");

  for (ssize_t index = 0; index < length; index += 1) {
    unsigned char byte = (unsigned char)data[index];

    switch (byte) {
      case '\\':
        send_line("\\\\");
        break;
      case '"':
        send_line("\\\"");
        break;
      case '\n':
        send_line("\\n");
        break;
      case '\r':
        send_line("\\r");
        break;
      case '\t':
        send_line("\\t");
        break;
      default: {
        if (byte < 0x20) {
          char escape[7];
          snprintf(escape, sizeof(escape), "\\u%04x", byte);
          send_line(escape);
        } else {
          char literal[2] = { (char)byte, '\0' };
          send_line(literal);
        }
        break;
      }
    }
  }

  send_line("\"}\n");
}

static char *decode_json_string(const char *input, size_t *decoded_length) {
  size_t length = strlen(input);
  char *decoded = malloc(length + 1);
  size_t output_index = 0;

  if (!decoded) {
    return NULL;
  }

  for (size_t index = 0; index < length; index += 1) {
    if (input[index] != '\\') {
      decoded[output_index++] = input[index];
      continue;
    }

    index += 1;
    if (index >= length) {
      free(decoded);
      return NULL;
    }

    switch (input[index]) {
      case '\\':
      case '"':
      case '/':
        decoded[output_index++] = input[index];
        break;
      case 'b':
        decoded[output_index++] = '\b';
        break;
      case 'f':
        decoded[output_index++] = '\f';
        break;
      case 'n':
        decoded[output_index++] = '\n';
        break;
      case 'r':
        decoded[output_index++] = '\r';
        break;
      case 't':
        decoded[output_index++] = '\t';
        break;
      case 'u': {
        if (index + 4 >= length) {
          free(decoded);
          return NULL;
        }

        char codepoint[5] = {
          input[index + 1],
          input[index + 2],
          input[index + 3],
          input[index + 4],
          '\0'
        };
        long value = strtol(codepoint, NULL, 16);
        decoded[output_index++] = value < 0x80 ? (char)value : '?';
        index += 4;
        break;
      }
      default:
        free(decoded);
        return NULL;
    }
  }

  decoded[output_index] = '\0';
  *decoded_length = output_index;
  return decoded;
}

static char **parse_string_array(const char *input, int *out_count) {
  size_t length = strlen(input);
  size_t index = 0;
  int capacity = 4;
  int count = 0;
  char **items = calloc((size_t)capacity + 1, sizeof(char *));

  if (!items) {
    return NULL;
  }

  while (index < length && isspace((unsigned char)input[index])) {
    index += 1;
  }

  if (index >= length || input[index] != '[') {
    free(items);
    return NULL;
  }
  index += 1;

  while (index < length) {
    while (index < length && isspace((unsigned char)input[index])) {
      index += 1;
    }

    if (index < length && input[index] == ']') {
      items[count] = NULL;
      *out_count = count;
      return items;
    }

    if (index >= length || input[index] != '"') {
      break;
    }
    index += 1;

    size_t start = index;
    bool escaped = false;

    while (index < length) {
      char character = input[index];

      if (!escaped && character == '"') {
        break;
      }

      if (!escaped && character == '\\') {
        escaped = true;
      } else {
        escaped = false;
      }

      index += 1;
    }

    if (index >= length) {
      break;
    }

    size_t encoded_length = index - start;
    char *encoded = malloc(encoded_length + 1);
    size_t decoded_length = 0;

    if (!encoded) {
      break;
    }

    memcpy(encoded, input + start, encoded_length);
    encoded[encoded_length] = '\0';

    char *decoded = decode_json_string(encoded, &decoded_length);
    free(encoded);

    if (!decoded) {
      break;
    }

    if (count >= capacity) {
      capacity *= 2;
      char **next_items = realloc(items, ((size_t)capacity + 1) * sizeof(char *));

      if (!next_items) {
        free(decoded);
        break;
      }

      items = next_items;
    }

    items[count++] = decoded;
    index += 1;

    while (index < length && isspace((unsigned char)input[index])) {
      index += 1;
    }

    if (index < length && input[index] == ',') {
      index += 1;
      continue;
    }

    if (index < length && input[index] == ']') {
      items[count] = NULL;
      *out_count = count;
      return items;
    }

    break;
  }

  for (int item_index = 0; item_index < count; item_index += 1) {
    free(items[item_index]);
  }
  free(items);
  return NULL;
}

static char *extract_json_string_field(const char *line, const char *field_name, size_t *decoded_length) {
  char pattern[64];
  snprintf(pattern, sizeof(pattern), "\"%s\":\"", field_name);

  const char *start = strstr(line, pattern);
  if (!start) {
    return NULL;
  }
  start += strlen(pattern);

  const char *cursor = start;
  bool escaped = false;

  while (*cursor) {
    if (!escaped && *cursor == '"') {
      size_t encoded_length = (size_t)(cursor - start);
      char *encoded = malloc(encoded_length + 1);

      if (!encoded) {
        return NULL;
      }

      memcpy(encoded, start, encoded_length);
      encoded[encoded_length] = '\0';

      char *decoded = decode_json_string(encoded, decoded_length);
      free(encoded);
      return decoded;
    }

    if (!escaped && *cursor == '\\') {
      escaped = true;
    } else {
      escaped = false;
    }

    cursor += 1;
  }

  return NULL;
}

static int extract_json_int_field(const char *line, const char *field_name, int default_value) {
  char pattern[64];
  snprintf(pattern, sizeof(pattern), "\"%s\":", field_name);

  const char *start = strstr(line, pattern);
  if (!start) {
    return default_value;
  }
  start += strlen(pattern);

  while (*start && isspace((unsigned char)*start)) {
    start += 1;
  }

  return (int)strtol(start, NULL, 10);
}

static void free_string_array(char **items, int count) {
  for (int index = 0; index < count; index += 1) {
    free(items[index]);
  }
  free(items);
}

static void handle_bridge_message(const char *line) {
  if (strstr(line, "\"type\":\"input\"")) {
    size_t decoded_length = 0;
    char *data = extract_json_string_field(line, "data", &decoded_length);

    if (!data) {
      send_error_message("invalid bridge input payload");
      return;
    }

    if (decoded_length > 0 && master_fd >= 0) {
      ssize_t ignored = write(master_fd, data, decoded_length);
      (void)ignored;
    }

    free(data);
    return;
  }

  if (strstr(line, "\"type\":\"resize\"")) {
    int cols = extract_json_int_field(line, "cols", 80);
    int rows = extract_json_int_field(line, "rows", 24);
    struct winsize size = {
      .ws_row = rows > 0 ? (unsigned short)rows : 24,
      .ws_col = cols > 0 ? (unsigned short)cols : 80,
      .ws_xpixel = 0,
      .ws_ypixel = 0
    };

    if (master_fd >= 0) {
      ioctl(master_fd, TIOCSWINSZ, &size);
    }
  }
}

int main(int argc, char **argv) {
  if (argc < 4) {
    send_error_message("pty helper requires <binary> <json-args> <cwd>");
    return 1;
  }

  const char *binary = argv[1];
  const char *raw_args = argv[2];
  const char *cwd = argv[3];
  int arg_count = 0;
  char **parsed_args = parse_string_array(raw_args, &arg_count);

  if (!parsed_args) {
    send_error_message("invalid bridge argument array");
    return 1;
  }

  char **exec_argv = calloc((size_t)arg_count + 2, sizeof(char *));
  if (!exec_argv) {
    free_string_array(parsed_args, arg_count);
    send_error_message("failed to allocate argv");
    return 1;
  }

  exec_argv[0] = (char *)binary;
  for (int index = 0; index < arg_count; index += 1) {
    exec_argv[index + 1] = parsed_args[index];
  }
  exec_argv[arg_count + 1] = NULL;

  signal(SIGINT, handle_signal);
  signal(SIGTERM, handle_signal);

  child_pid = forkpty(&master_fd, NULL, NULL, NULL);
  if (child_pid < 0) {
    free(exec_argv);
    free_string_array(parsed_args, arg_count);
    send_error_message("forkpty failed");
    return 1;
  }

  if (child_pid == 0) {
    chdir(cwd);
    setenv("TERM", "xterm-256color", 1);
    setenv("COLORTERM", "truecolor", 1);
    setenv("TERM_PROGRAM", "tmuxib", 1);
    execvp(binary, exec_argv);
    _exit(127);
  }

  send_ready();

  char stdin_buffer[65536];
  size_t stdin_length = 0;
  bool stdin_open = true;

  while (1) {
    int status = 0;
    pid_t waited = waitpid(child_pid, &status, WNOHANG);

    if (waited == child_pid) {
      send_exit_status(status);
      break;
    }

    if (should_terminate) {
      kill(child_pid, should_terminate);
      waitpid(child_pid, &status, 0);
      send_exit_status(status);
      break;
    }

    struct pollfd fds[2];
    nfds_t count = 0;

    if (stdin_open) {
      fds[count].fd = STDIN_FILENO;
      fds[count].events = POLLIN;
      count += 1;
    }

    fds[count].fd = master_fd;
    fds[count].events = POLLIN | POLLHUP;
    count += 1;

    int poll_result = poll(fds, count, 100);
    if (poll_result < 0) {
      if (errno == EINTR) {
        continue;
      }

      send_error_message("poll failed");
      break;
    }

    nfds_t master_index = count - 1;

    if (stdin_open && (fds[0].revents & POLLIN)) {
      ssize_t read_count = read(STDIN_FILENO, stdin_buffer + stdin_length, sizeof(stdin_buffer) - stdin_length - 1);

      if (read_count <= 0) {
        stdin_open = false;
      } else {
        stdin_length += (size_t)read_count;
        stdin_buffer[stdin_length] = '\0';

        char *line_start = stdin_buffer;
        char *newline = NULL;

        while ((newline = strchr(line_start, '\n')) != NULL) {
          *newline = '\0';
          if (*line_start) {
            handle_bridge_message(line_start);
          }
          line_start = newline + 1;
        }

        size_t remaining = stdin_length - (size_t)(line_start - stdin_buffer);
        memmove(stdin_buffer, line_start, remaining);
        stdin_length = remaining;
        stdin_buffer[stdin_length] = '\0';
      }
    } else if (stdin_open && (fds[0].revents & (POLLHUP | POLLERR | POLLNVAL))) {
      stdin_open = false;
    }

    if (fds[master_index].revents & POLLIN) {
      char output[4096];
      ssize_t read_count = read(master_fd, output, sizeof(output));

      if (read_count > 0) {
        send_data(output, read_count);
      }
    }
  }

  if (master_fd >= 0) {
    close(master_fd);
  }

  free(exec_argv);
  free_string_array(parsed_args, arg_count);
  return 0;
}

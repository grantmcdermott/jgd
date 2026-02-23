# Mock NDJSON servers for jgd testthat tests
#
# Two transport variants:
#   start_mock_server_local() — local IPC socket via processx (Unix domain socket
#                              on Unix, Windows named pipe on Windows)
#   start_mock_server_tcp()  — TCP socket (base R), works on all platforms
#
# Both run a background R process (via callr::r_bg) that:
# 1. Listens on a socket
# 2. Accepts one jgd device connection
# 3. Responds to metrics_request messages with approximate values
# 4. Collects all received NDJSON messages
# 5. Returns collected messages when the device sends "close"

start_mock_server_local = function(send_welcome = FALSE) {
  skip_if_not_installed("callr")
  skip_if_not_installed("processx")
  skip_if_not_installed("jsonlite")

  is_windows = (.Platform$OS.type == "windows")

  if (is_windows) {
    # Windows: named pipe via processx
    pipe_name = sprintf("jgd-test-%d-%s", Sys.getpid(),
                        basename(tempfile()))
    # processx expects \\?\pipe\NAME (extended-length path prefix);
    # the C client uses \\.\pipe\NAME (device namespace) — both resolve
    # to the same kernel pipe object
    win_path = paste0("\\\\?\\pipe\\", pipe_name)
    ready_file = tempfile(pattern = "jgd-test-ready-", fileext = ".txt")
  } else {
    socket_path = tempfile(pattern = "jgd-test-", fileext = ".sock")
  }

  bg = callr::r_bg(
    function(conn_path, ready_file, send_welcome) {
      `%||%` = function(x, y) if (is.null(x)) y else x
      server = processx::conn_create_unix_socket(conn_path)

      # Signal readiness: on Windows write a ready file (pipe has no filesystem
      # presence); on Unix the socket file itself signals readiness
      if (!is.null(ready_file)) {
        writeLines("ready", ready_file)
      }

      # Wait for client connection (30s timeout)
      # poll() returns "connect" (not "ready") for new connections on a
      # listening Unix socket / named pipe
      res = processx::poll(list(server), 30000)
      if (!res[[1L]] %in% c("ready", "connect")) {
        stop("No client connected within 30s (poll returned: ", res[[1L]], ")")
      }
      processx::conn_accept_unix_socket(server)

      welcome_sent = FALSE
      messages = list()
      repeat {
        res = processx::poll(list(server), 5000)
        if (!res[[1L]] %in% c("ready", "connect")) {
          next
        }

        lines = processx::conn_read_lines(server)
        for (line in lines) {
          if (!nzchar(line)) {
            next
          }
          msg = jsonlite::fromJSON(line, simplifyVector = FALSE)
          messages = c(messages, list(msg))

          # Send server_info welcome after receiving the first message
          if (send_welcome && !welcome_sent) {
            welcome = list(
              type = "server_info",
              serverName = "jgd-mock",
              protocolVersion = 1L,
              serverInfo = list(httpUrl = "http://127.0.0.1:9999/")
            )
            processx::conn_write(
              server,
              paste0(jsonlite::toJSON(welcome, auto_unbox = TRUE), "\n")
            )
            welcome_sent = TRUE
          }

          # Respond to metrics_request so tests run fast
          if (identical(msg$type, "metrics_request")) {
            resp = if (identical(msg$kind, "strWidth")) {
              list(
                type = "metrics_response",
                id = msg$id,
                width = nchar(msg$str %||% "") * 8.0
              )
            } else {
              list(
                type = "metrics_response",
                id = msg$id,
                ascent = 10.0,
                descent = 3.0,
                width = 8.0
              )
            }
            processx::conn_write(
              server,
              paste0(jsonlite::toJSON(resp, auto_unbox = TRUE), "\n")
            )
          }

          if (identical(msg$type, "close")) break
        }

        # Exit loop after close
        if (
          length(messages) > 0 &&
            identical(messages[[length(messages)]]$type, "close")
        ) {
          break
        }
      }

      close(server)
      messages
    },
    args = list(
      conn_path = if (is_windows) win_path else socket_path,
      ready_file = if (is_windows) ready_file else NULL,
      send_welcome = send_welcome
    ),
    supervise = TRUE
  )

  if (is_windows) {
    # Wait for the ready file to appear (pipe has no filesystem presence)
    for (i in seq_len(30)) {
      if (file.exists(ready_file)) break
      Sys.sleep(0.1)
    }
    if (!file.exists(ready_file)) {
      bg$kill()
      skip("Mock server pipe not ready in time")
    }
    client_uri = paste0("npipe:///", pipe_name)
  } else {
    # Wait for the socket file to appear
    for (i in seq_len(30)) {
      if (file.exists(socket_path)) break
      Sys.sleep(0.1)
    }
    if (!file.exists(socket_path)) {
      bg$kill()
      skip("Mock server socket not created in time")
    }
    client_uri = socket_path
  }

  list(
    bg = bg,
    socket_path = client_uri,
    collect = function(timeout = 10000) {
      bg$wait(timeout)
      if (bg$get_exit_status() != 0) {
        stop("Mock server exited with error: ", bg$read_error())
      }
      bg$get_result()
    },
    cleanup = function() {
      if (bg$is_alive()) {
        bg$kill()
      }
      if (!is_windows) {
        unlink(socket_path)
      } else {
        unlink(ready_file)
      }
    }
  )
}

# TCP mock server using base R sockets (works on all platforms including Windows)
start_mock_server_tcp = function(send_welcome = FALSE) {
  skip_if_not_installed("callr")
  skip_if_not_installed("jsonlite")

  port_file = tempfile(pattern = "jgd-tcp-port-", fileext = ".txt")

  bg = callr::r_bg(
    function(port_file, send_welcome) {
      `%||%` = function(x, y) if (is.null(x)) y else x
      # Find a free port and start listening
      server = NULL
      port = NULL
      for (i in seq_len(20)) {
        candidate = sample(10000L:60000L, 1L)
        result = tryCatch(serverSocket(candidate), error = function(e) NULL)
        if (!is.null(result)) {
          server = result
          port = candidate
          break
        }
      }
      if (is.null(port)) {
        stop("Could not find free port for TCP mock server")
      }

      on.exit(close(server), add = TRUE)

      # Signal readiness with port number
      writeLines(as.character(port), port_file)

      # Accept one client connection
      conn = socketAccept(server, blocking = TRUE, open = "r+")
      on.exit(close(conn), add = TRUE)

      welcome_sent = FALSE
      messages = list()
      repeat {
        ready = socketSelect(list(conn), timeout = 5)
        if (!ready) {
          next
        }

        line = readLines(conn, n = 1)
        if (length(line) == 0 || !nzchar(line)) {
          next
        }

        msg = jsonlite::fromJSON(line, simplifyVector = FALSE)
        messages = c(messages, list(msg))

        # Send server_info welcome after receiving the first message
        if (send_welcome && !welcome_sent) {
          welcome = list(
            type = "server_info",
            serverName = "jgd-mock",
            protocolVersion = 1L,
            serverInfo = list(httpUrl = "http://127.0.0.1:9999/")
          )
          writeLines(jsonlite::toJSON(welcome, auto_unbox = TRUE), conn)
          flush(conn)
          welcome_sent = TRUE
        }

        # Respond to metrics_request so tests run fast
        if (identical(msg$type, "metrics_request")) {
          resp = if (identical(msg$kind, "strWidth")) {
            list(
              type = "metrics_response",
              id = msg$id,
              width = nchar(msg$str %||% "") * 8.0
            )
          } else {
            list(
              type = "metrics_response",
              id = msg$id,
              ascent = 10.0,
              descent = 3.0,
              width = 8.0
            )
          }
          writeLines(jsonlite::toJSON(resp, auto_unbox = TRUE), conn)
          flush(conn)
        }

        if (identical(msg$type, "close")) break
      }

      messages
    },
    args = list(port_file = port_file, send_welcome = send_welcome),
    supervise = TRUE
  )

  # Wait for the port file to appear (server is listening)
  port = NULL
  for (i in seq_len(50)) {
    if (file.exists(port_file)) {
      port_str = readLines(port_file, n = 1, warn = FALSE)
      if (length(port_str) > 0 && nzchar(port_str)) {
        port = as.integer(port_str)
        break
      }
    }
    Sys.sleep(0.1)
  }
  if (is.null(port)) {
    bg$kill()
    skip("Mock TCP server did not start in time")
  }

  list(
    bg = bg,
    port = port,
    socket_url = sprintf("tcp://127.0.0.1:%d", port),
    collect = function(timeout = 10000) {
      bg$wait(timeout)
      if (bg$get_exit_status() != 0) {
        stop("Mock TCP server exited with error: ", bg$read_error())
      }
      bg$get_result()
    },
    cleanup = function() {
      if (bg$is_alive()) {
        bg$kill()
      }
      unlink(port_file)
    }
  )
}

# Convenience: open jgd device connected to mock server, run expr, close,
# and return all captured NDJSON messages.
with_mock_jgd = function(
  expr,
  width = 4,
  height = 3,
  dpi = 72,
  transport = c("unix", "tcp"),
  send_welcome = FALSE
) {
  transport = match.arg(transport)
  if (transport == "tcp") {
    server = start_mock_server_tcp(send_welcome = send_welcome)
    socket_addr = server$socket_url
  } else {
    server = start_mock_server_local(send_welcome = send_welcome)
    socket_addr = server$socket_path
  }
  withr::defer(server$cleanup())

  jgd(width = width, height = height, dpi = dpi, socket = socket_addr)
  force(expr)
  dev.off()

  server$collect()
}

# Extract frame messages from a list of collected messages
extract_frames = function(msgs) {
  Filter(function(m) identical(m$type, "frame"), msgs)
}

# Extract all ops across all frames
extract_ops = function(msgs) {
  frames = extract_frames(msgs)
  unlist(lapply(frames, function(f) f$plot$ops), recursive = FALSE)
}

# Extract ops of a specific type
extract_ops_by_type = function(msgs, op_type) {
  ops = extract_ops(msgs)
  Filter(function(o) identical(o$op, op_type), ops)
}

# Snapshot an R value as pretty-printed JSON matching jgd wire format
expect_json_snapshot = function(x) {
  json = jsonlite::toJSON(x, auto_unbox = TRUE, pretty = TRUE)
  expect_snapshot(cat(json))
}

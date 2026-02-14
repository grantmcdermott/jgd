# Unix: jgd() opens a device and dev.off() closes it

    Code
      jgd(socket = "unix:///nonexistent-jgd-test.sock")
    Condition
      Warning in `jgd()`:
      jgd: could not connect to renderer. Plots will be recorded but not displayed until connection is established.

# Unix: jgd() respects JGD_SOCKET env var

    Code
      jgd()
    Condition
      Warning in `jgd()`:
      jgd: could not connect to renderer. Plots will be recorded but not displayed until connection is established.

# Unix: jgd() respects jgd.socket option

    Code
      jgd()
    Condition
      Warning in `jgd()`:
      jgd: could not connect to renderer. Plots will be recorded but not displayed until connection is established.

# Unix: drawing works without server connection

    Code
      jgd(socket = "unix:///nonexistent-jgd-draw-test.sock")
    Condition
      Warning in `jgd()`:
      jgd: could not connect to renderer. Plots will be recorded but not displayed until connection is established.

# TCP: jgd() opens a device and dev.off() closes it

    Code
      jgd(socket = "tcp://127.0.0.1:1")
    Condition
      Warning in `jgd()`:
      jgd: could not connect to renderer. Plots will be recorded but not displayed until connection is established.

# TCP: jgd() respects JGD_SOCKET env var

    Code
      jgd()
    Condition
      Warning in `jgd()`:
      jgd: could not connect to renderer. Plots will be recorded but not displayed until connection is established.

# TCP: jgd() respects jgd.socket option

    Code
      jgd()
    Condition
      Warning in `jgd()`:
      jgd: could not connect to renderer. Plots will be recorded but not displayed until connection is established.

# TCP: drawing works without server connection

    Code
      jgd(socket = "tcp://127.0.0.1:1")
    Condition
      Warning in `jgd()`:
      jgd: could not connect to renderer. Plots will be recorded but not displayed until connection is established.

# jgd() validates socket parameter type

    Code
      jgd(socket = 42)
    Condition
      Error in `jgd()`:
      ! is.character(socket) is not TRUE

---

    Code
      jgd(socket = c("a", "b"))
    Condition
      Error in `jgd()`:
      ! length(socket) == 1L is not TRUE


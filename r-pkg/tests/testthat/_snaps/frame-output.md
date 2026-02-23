# close message JSON matches snapshot

    Code
      cat(json)
    Output
      {
        "type": "close"
      }

# frame device metadata matches snapshot

    Code
      cat(json)
    Output
      {
        "version": 1,
        "device": {
          "width": 288,
          "height": 216,
          "dpi": 72,
          "bg": "rgba(255,255,255,1)"
        }
      }

# rect op gc fields match snapshot

    Code
      cat(json)
    Output
      {
        "col": "rgba(0,0,255,1)",
        "fill": "rgba(255,0,0,1)",
        "lwd": 2,
        "lty": [],
        "lend": "round",
        "ljoin": "round",
        "lmitre": 10,
        "font": {
          "family": "",
          "face": 1,
          "size": 12,
          "lineheight": 1
        }
      }

# rect coordinates use full double precision

    Code
      cat(jsonlite::toJSON(list(x0 = op$x0, y0 = op$y0, x1 = op$x1, y1 = op$y1),
      auto_unbox = TRUE, pretty = TRUE, digits = I(15)))
    Output
      {
        "x0": 99.5555555555555,
        "y0": 179.428571428571,
        "x1": 188.444444444444,
        "y1": 36.5714285714286
      }

# text op structure matches snapshot

    Code
      cat(json)
    Output
      {
        "op": "text",
        "str": "snapshot test",
        "rot": 0,
        "hadj": 0.5,
        "gc": {
          "col": "rgba(0,0,0,1)",
          "fill": "rgba(255,255,255,1)",
          "lwd": 1,
          "lty": [],
          "lend": "round",
          "ljoin": "round",
          "lmitre": 10,
          "font": {
            "family": "",
            "face": 1,
            "size": 12,
            "lineheight": 1
          }
        }
      }


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


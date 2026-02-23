# malformed JSON: device metadata matches snapshot

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

# malformed JSON: rect gc fields match snapshot

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


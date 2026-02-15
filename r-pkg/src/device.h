#ifndef JGD_DEVICE_H
#define JGD_DEVICE_H

#include "display_list.h"
#include "transport.h"
#include "json_writer.h"

typedef struct {
    jgd_transport_t transport;
    jgd_page_t page;
    json_writer_t frame_buf;  /* reusable buffer for frame serialization */
    char session_id[64];
    double width;             /* device width in inches */
    double height;            /* device height in inches */
    double dpi;
    int page_count;
    int drawing;              /* 1 if between mode(1) and mode(0) */
    int last_flushed_ops;     /* op_count at last flush */
    int hold_level;           /* >0 means display updates are held (holdflush) */
    int replaying;            /* guard against re-entry from GEplayDisplayList */
    double pending_w;         /* pending resize width in pixels, 0 = none */
    double pending_h;         /* pending resize height in pixels */
    void *ge_dev;             /* pGEDevDesc — stable for device lifetime */
#ifdef _WIN32
    void *hwnd;               /* HWND for message-only window (resize polling) */
    int timer_active;
#else
    void *input_handler;      /* InputHandler* for R event-loop resize polling */
#endif
} jgd_state_t;

/* Flush the current frame over the transport. */
void jgd_flush_frame(jgd_state_t *st, int incremental);

/* Register/remove the R input handler that watches the transport socket
   for incoming resize messages.  Called from C_jgd (open) and cb_close. */
void jgd_register_input_handler(jgd_state_t *st);
void jgd_remove_input_handler(jgd_state_t *st);

#endif

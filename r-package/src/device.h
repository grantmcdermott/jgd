#ifndef VSCGD_DEVICE_H
#define VSCGD_DEVICE_H

#include "display_list.h"
#include "transport.h"
#include "json_writer.h"

typedef struct {
    vscgd_transport_t transport;
    vscgd_page_t page;
    json_writer_t frame_buf;  /* reusable buffer for frame serialization */
    char session_id[64];
    double width;             /* device width in inches */
    double height;            /* device height in inches */
    double dpi;
    int page_count;
    int drawing;              /* 1 if between mode(1) and mode(0) */
    int last_flushed_ops;     /* op_count at last flush */
    int replaying;            /* guard against re-entry from GEplayDisplayList */
    double pending_w;         /* pending resize width in pixels, 0 = none */
    double pending_h;         /* pending resize height in pixels */
} vscgd_state_t;

#endif

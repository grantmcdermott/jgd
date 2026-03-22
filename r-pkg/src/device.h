#ifndef JGD_DEVICE_H
#define JGD_DEVICE_H

#include "display_list.h"
#include "transport.h"

#include <Rinternals.h>

#define JGD_MAX_INFO_PAIRS 16
#define JGD_MAX_SNAPSHOTS 50
#define JGD_INFO_KEY_LEN 64
#define JGD_INFO_VAL_LEN 256

typedef struct {
    char key[JGD_INFO_KEY_LEN];
    char val[JGD_INFO_VAL_LEN];
} jgd_info_pair_t;

typedef struct {
    jgd_transport_t transport;
    jgd_page_t page;
    char session_id[64];
    double width;             /* device width in inches */
    double height;            /* device height in inches */
    double dpi;
    int page_count;
    int drawing;              /* 1 if between mode(1) and mode(0) */
    int last_flushed_ops;     /* op_count at last flush */
    int hold_level;           /* R's dev.hold/dev.flush level (>0 = held) */
    int replaying;            /* guard against re-entry from GEplayDisplayList */
    int new_page;             /* 1 after cb_newPage; cleared on first complete flush */
    int resize_replay;        /* 1 when poll_resize_impl is flushing a replay frame */
    int flush_plot_index;     /* plotIndex for the current replay frame, -1 = none */
    double pending_w;         /* pending resize width in pixels, 0 = none */
    double pending_h;         /* pending resize height in pixels */
    int pending_plot_index;   /* plotIndex from resize msg, -1 = none */
    /* Single-entry buffer for a plotIndex resize read by check_incoming
     * during drawing.  plotIndex resizes target past plots — their dims
     * must NOT be applied to the current page.  poll_resize_impl drains
     * this buffer before reading from the transport. */
    int has_buffered_resize;
    double buffered_w;
    double buffered_h;
    int buffered_plot_index;
    void *ge_dev;             /* pGEDevDesc — stable for device lifetime */
    SEXP snapshot_store;      /* VECSXP holding GEcreateSnapshot results */
    int snapshot_count;       /* number of stored snapshots */
    int evicted_count;        /* number of snapshots evicted from the front */
    SEXP last_snapshot;       /* most recent complete-page snapshot, or R_NilValue */
    char server_name[128];
    int protocol_version;
    char server_transport[32];
    int server_info_received;
    jgd_info_pair_t server_info_pairs[JGD_MAX_INFO_PAIRS];
    int n_info_pairs;
#ifdef _WIN32
    void *hwnd;               /* HWND for message-only window (resize polling) */
    int timer_active;
#else
    void *input_handler;      /* InputHandler* for R event-loop resize polling */
#endif
    int debug_frames;         /* 1 to log frame details to stderr */
    /* Experimental extended graphics context (gc.ext).
     * A pre-serialized JSON string provided by the user via .Call(C_jgd_set_ext).
     * When non-NULL, gc_to_cjson() embeds it as the "ext" field in every gc object.
     * jgd does not validate the contents — that is the caller's responsibility. */
    char *ext_json;
    /* Page-level copy of ext_json, captured at cb_newPage time.
     * Drawing ops read from this (not ext_json) so that ext survives
     * with_jgd_ext's on.exit cleanup and display list replay on resize. */
    char *page_ext_json;
    /* Pre-parsed cJSON tree of page_ext_json, cached to avoid re-parsing
     * for every drawing op.  Owned by jgd_state_t; freed when page_ext_json
     * changes (cb_newPage) or at cb_close. */
    cJSON *page_ext_parsed;
    /* Per-snapshot ext, parallel to snapshot_store.  Stored when a snapshot
     * is saved so that plotIndex replay can restore the correct ext. */
    char *snapshot_ext[JGD_MAX_SNAPSHOTS];
} jgd_state_t;

/* Flush the current frame over the transport. */
void jgd_flush_frame(jgd_state_t *st, int incremental);

/* Register/remove the R input handler that watches the transport socket
   for incoming resize messages.  Called from C_jgd (open) and cb_close. */
void jgd_register_input_handler(jgd_state_t *st);
void jgd_remove_input_handler(jgd_state_t *st);

/* Parse a JSON message; if it's a resize, store dimensions in *w, *h and
   optionally extract plotIndex into *plot_index (-1 if absent).  Returns 1. */
int jgd_try_parse_resize(const char *buf, double *w, double *h, int *plot_index);

/* Find grid state in a GEcreateSnapshot SEXP by looking for the
   pkgName="grid" attribute.  Returns the grid state VECSXP (with
   LENGTH >= 2) or R_NilValue if not found or malformed. */
SEXP find_grid_state(SEXP snap);

#endif

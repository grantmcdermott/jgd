#include <R.h>
#include <Rinternals.h>
#include <R_ext/Rdynload.h>

SEXP C_jgd(SEXP s_width, SEXP s_height, SEXP s_dpi, SEXP s_socket);
SEXP C_jgd_poll_resize(void);

static const R_CallMethodDef CallEntries[] = {
    {"C_jgd",             (DL_FUNC) &C_jgd,             4},
    {"C_jgd_poll_resize", (DL_FUNC) &C_jgd_poll_resize, 0},
    {NULL, NULL, 0}
};

void R_init_jgd(DllInfo *dll) {
    R_registerRoutines(dll, NULL, CallEntries, NULL, NULL);
    R_useDynamicSymbols(dll, FALSE);
    R_forceSymbols(dll, TRUE);
}

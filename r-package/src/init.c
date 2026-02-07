#include <R.h>
#include <Rinternals.h>
#include <R_ext/Rdynload.h>

SEXP C_vscgd(SEXP s_width, SEXP s_height, SEXP s_dpi);

static const R_CallMethodDef CallEntries[] = {
    {"C_vscgd", (DL_FUNC) &C_vscgd, 3},
    {NULL, NULL, 0}
};

void R_init_vscgd(DllInfo *dll) {
    R_registerRoutines(dll, NULL, CallEntries, NULL, NULL);
    R_useDynamicSymbols(dll, FALSE);
    R_forceSymbols(dll, TRUE);
}

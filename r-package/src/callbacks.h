#ifndef VSCGD_CALLBACKS_H
#define VSCGD_CALLBACKS_H

#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsEngine.h>

/* Install all callbacks onto a DevDesc */
void vscgd_set_callbacks(pDevDesc dd);

#endif

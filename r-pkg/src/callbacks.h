#ifndef JGD_CALLBACKS_H
#define JGD_CALLBACKS_H

#include <R.h>
#include <Rinternals.h>
#include <R_ext/GraphicsEngine.h>

void jgd_set_callbacks(pDevDesc dd);

/* Check whether a DevDesc belongs to a jgd device. */
int jgd_is_jgd_device(pDevDesc dd);

#endif

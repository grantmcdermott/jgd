# Ensure no pre-existing graphics devices interfere with tests
while (dev.cur() > 1L) {
  dev.off()
}

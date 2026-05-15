export async function checkGgplot2Available(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("Rscript", {
      args: ["-e", 'library(ggplot2); cat("ok")'],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);
    return output.success && stdout.includes("ok");
  } catch {
    return false;
  }
}

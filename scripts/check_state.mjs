import { execSync } from "node:child_process";
try {
  const dockerOut = execSync("docker --version 2>&1 || echo no_docker", { encoding: "utf8", timeout: 10000 });
  process.stdout.write("DOCKER: " + dockerOut.trim());
} catch(e) {
  process.stdout.write("DOCKER_ERROR: " + e.message);
}

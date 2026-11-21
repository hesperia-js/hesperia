import { writeFileSync } from "node:fs";

writeFileSync(process.argv[2], "ready\n", { flag: "wx" });
setInterval(() => {}, 1000);

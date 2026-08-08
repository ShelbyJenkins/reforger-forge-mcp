const mode = process.argv[2];

if (mode === "hang") {
  setInterval(() => undefined, 1_000);
} else {
  process.stderr.write("fixture abnormal reader exit\n");
  process.exit(86);
}


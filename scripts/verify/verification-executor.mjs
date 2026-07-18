import { spawn } from "node:child_process";
import process from "node:process";
import { root } from "./adaptive-state.mjs";

function printableCommand(command) {
  const executable = command.executable === process.execPath ? "node" : command.executable;
  return [executable, ...command.args].join(" ");
}

export function printPlan(plan) {
  console.log(`Adaptive verification mode: ${plan.options.mode}`);
  console.log(`Verification scope: ${plan.verificationScope}`);
  console.log(`Reason: ${plan.reason}`);

  const commands = [...plan.readOnlyCommands, ...plan.workspaceCommands];
  if (!plan.options.printPlan) {
    console.log(
      `Selected ${commands.length} check(s) for ${plan.classifiedPaths.length} changed path(s).`,
    );
    return;
  }

  console.log(
    `Changed-path source: ${plan.options.simulatedPaths.length > 0 ? "simulated --path input" : plan.gitAvailable ? "Git worktree" : "no Git worktree"}\n`,
  );

  if (plan.classifiedPaths.length === 0) {
    console.log("Changed paths: none");
  } else {
    console.log("Changed paths:");
    for (const entry of plan.classifiedPaths) {
      console.log(`- ${entry.path}: ${entry.categories.join(", ")}`);
    }
  }

  if (commands.length === 0) {
    console.log(
      "\nSelected checks: none; paths are local/generated or no relevant current surface exists.",
    );
    return;
  }

  console.log("\nSelected checks:");
  for (const command of commands) {
    console.log(`- Would run [${command.phase}]: ${printableCommand(command)}`);
    console.log(`  Reason: ${command.reason}`);
  }
}

function outputCaptureLimit() {
  const configured = Number.parseInt(process.env.VERIFY_MAX_CAPTURE_BYTES ?? "2097152", 10);
  return Number.isInteger(configured) && configured >= 1024
    ? Math.min(configured, 64 * 1024 * 1024)
    : 2 * 1024 * 1024;
}

function boundedOutputCollector() {
  const chunks = [];
  const limit = outputCaptureLimit();
  let capturedBytes = 0;
  let truncated = false;
  return {
    add(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = limit - capturedBytes;
      if (remaining > 0) {
        const captured = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.length;
      }
      if (buffer.length > remaining) truncated = true;
    },
    buffer() {
      if (truncated) {
        chunks.push(
          Buffer.from(
            `\n[verification output truncated after ${limit} bytes; run the command directly for full output]\n`,
          ),
        );
      }
      return Buffer.concat(chunks);
    },
  };
}

function runCommand(command) {
  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      cwd: root,
      env: { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "error" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = boundedOutputCollector();
    const stderr = boundedOutputCollector();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({
        ...result,
        command,
        stderr: stderr.buffer(),
        stdout: stdout.buffer(),
      });
    };
    child.stdout?.on("data", (chunk) => stdout.add(chunk));
    child.stderr?.on("data", (chunk) => stderr.add(chunk));
    child.on("error", (error) => finish({ status: null, error }));
    child.on("close", (status, signal) => finish({ status, signal, error: null }));
  });
}

function writeBuffer(stream, buffer) {
  if (!buffer || buffer.length === 0) return;
  stream.write(buffer);
  if (buffer.at(-1) !== 10) stream.write("\n");
}

function printResult(result) {
  console.log(`\n[${result.command.label}] ${printableCommand(result.command)}`);
  writeBuffer(process.stdout, result.stdout);
  writeBuffer(process.stderr, result.stderr);
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error(`Terminated by signal ${result.signal}.`);
}

function parallelLimit() {
  const configured = Number.parseInt(process.env.VERIFY_MAX_PARALLEL ?? "4", 10);
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, 8) : 4;
}

async function runReadOnlyCommands(commands) {
  if (commands.length === 0) return;
  const results = new Array(commands.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < commands.length) {
      const index = nextIndex++;
      results[index] = await runCommand(commands[index]);
    }
  };
  const workers = Array.from({ length: Math.min(parallelLimit(), commands.length) }, () =>
    worker(),
  );
  await Promise.all(workers);

  const failures = [];
  for (const result of results) {
    printResult(result);
    if (result.error || result.status !== 0) failures.push(result.command.label);
  }
  if (failures.length > 0) {
    throw new Error(`Independent verification checks failed: ${failures.join(", ")}`);
  }
}

async function runSequentialCommands(commands, failurePrefix) {
  for (const command of commands) {
    const result = await runCommand(command);
    printResult(result);
    if (result.error || result.status !== 0) {
      throw new Error(`${failurePrefix}: ${command.label}`);
    }
  }
}

export async function runPlan(plan) {
  printPlan(plan);
  if (plan.options.printPlan) return;

  const independentCommands = plan.readOnlyCommands.filter(
    (command) => command.phase === "read-only",
  );
  const serialCommands = plan.readOnlyCommands.filter((command) => command.phase !== "read-only");
  await runReadOnlyCommands(independentCommands);
  await runSequentialCommands(serialCommands, "Serial verification check failed");
  await runSequentialCommands(plan.workspaceCommands, "Workspace lifecycle failed");
  console.log("\nDeterministic verification passed.");
}

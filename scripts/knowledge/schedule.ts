/**
 * schedule.ts — Windows Task Scheduler helper for knowledge library producer.
 *
 * Implements:
 * - generateTaskXml: Generates valid Windows Task Scheduler XML with:
 *   - 5-minute repetition interval (PT5M)
 *   - Random jitter (0-30s, PT30S)
 *   - Execution time limit (15m, PT15M)
 *   - Restart on failure with backoff (PT1M, count 3)
 *   - Multiple instances policy (IgnoreNew)
 *   - Boot recovery (StartWhenAvailable=true)
 *   - Least privilege principal (RunLevel=LeastPrivilege, LogonType=InteractiveToken)
 *   - Proper XML escaping for spaces, Korean paths (UTF-8), and quotes
 * - planTaskSchedule: Non-destructive preview returning XML and schtasks command
 * - installTaskSchedule / removeTaskSchedule: Explicit execution only, never in tests
 */

import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ============================================================================
// Types & Configuration
// ============================================================================

export interface TaskScheduleConfig {
  taskName?: string;
  taskPath?: string;
  description?: string;
  intervalMinutes?: number;
  randomJitterSeconds?: number;
  executionLimitMinutes?: number;
  restartOnFailureCount?: number;
  restartIntervalMinutes?: number;
  startBoundary?: string;
  nodePath?: string;
  scriptPath?: string;
  arguments?: string[] | string;
  workingDirectory?: string;
  knowledgeHome?: string;
  runLevel?: "LeastPrivilege" | "HighestAvailable";
  logonType?: "InteractiveToken" | "S4U" | "Password";
  author?: string;
}

export interface PlannedTaskSchedule {
  xml: string;
  taskName: string;
  command: string;
}

export interface TaskScheduleExecutor {
  execFileAsync?: (
    file: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
}

export interface TaskScheduleExecutionResult {
  success: boolean;
  taskName: string;
  command: string;
  output: string;
}

// ============================================================================
// XML Escaping & Utilities
// ============================================================================

/**
 * Escapes special XML characters: &, <, >, ", '
 */
export function escapeXml(str: string): string {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Quotes an argument if it contains spaces or quotes, or if force is true.
 */
function quoteArg(arg: string, force = false): string {
  if (force || arg.includes(" ") || arg.includes("\t") || arg.includes('"')) {
    const escaped = arg.replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return arg;
}

// ============================================================================
// Task XML Generator
// ============================================================================

/**
 * Generates a well-formed Windows Task Scheduler XML document conforming to
 * the Task Scheduler 2.0 schema (http://schemas.microsoft.com/windows/2004/02/mit/task).
 */
export function generateTaskXml(options: TaskScheduleConfig = {}): string {
  const taskName = options.taskName || "HarnessKnowledgeProducer";
  const taskUri = options.taskPath
    ? `${options.taskPath.replace(/\/+$/, "")}\\${taskName}`
    : `\\Harness\\${taskName}`;
  const description =
    options.description ||
    "Harness Knowledge Library producer cycle: Git pull, embed, catalog upsert, and snapshot publishing.";
  const author = options.author || "create-agent-harness";

  const intervalMinutes = Math.max(1, options.intervalMinutes ?? 5);
  const randomJitterSeconds = Math.max(0, options.randomJitterSeconds ?? 30);
  const executionLimitMinutes = Math.max(1, options.executionLimitMinutes ?? 15);
  const restartOnFailureCount = Math.max(0, options.restartOnFailureCount ?? 3);
  const restartIntervalMinutes = Math.max(1, options.restartIntervalMinutes ?? 1);
  const startBoundary = options.startBoundary || "2026-01-01T00:00:00";

  const runLevel = options.runLevel || "LeastPrivilege";
  const logonType = options.logonType || "InteractiveToken";

  const nodePath = options.nodePath || process.execPath;
  const workingDir = options.workingDirectory || options.knowledgeHome;

  // Format arguments string
  let argsString = "";
  if (options.arguments) {
    if (Array.isArray(options.arguments)) {
      argsString = options.arguments.map((a) => quoteArg(a)).join(" ");
    } else {
      argsString = options.arguments;
    }
  } else if (options.scriptPath) {
    const quotedScript = quoteArg(options.scriptPath, true);
    argsString = quotedScript;
    if (options.knowledgeHome) {
      argsString += ` --home ${quoteArg(options.knowledgeHome, true)}`;
    }
  }

  const argumentsElement = argsString
    ? `      <Arguments>${escapeXml(argsString)}</Arguments>\n`
    : "";

  const workingDirElement = workingDir
    ? `      <WorkingDirectory>${escapeXml(workingDir)}</WorkingDirectory>\n`
    : "";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(description)}</Description>
    <Author>${escapeXml(author)}</Author>
    <URI>${escapeXml(taskUri)}</URI>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${escapeXml(startBoundary)}</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT${intervalMinutes}M</Interval>
        <Duration>P9999D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <RandomDelay>PT${randomJitterSeconds}S</RandomDelay>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>${escapeXml(logonType)}</LogonType>
      <RunLevel>${escapeXml(runLevel)}</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT${executionLimitMinutes}M</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT${restartIntervalMinutes}M</Interval>
      <Count>${restartOnFailureCount}</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(nodePath)}</Command>
${argumentsElement}${workingDirElement}    </Exec>
  </Actions>
</Task>`;

  return xml;
}

// ============================================================================
// Schedule Planning & Non-Destructive Inspection
// ============================================================================

/**
 * Plans task configuration and generates XML and schtasks command without
 * executing any external commands.
 */
export function planTaskSchedule(options: TaskScheduleConfig = {}): PlannedTaskSchedule {
  const taskName = options.taskName || "HarnessKnowledgeProducer";
  const xml = generateTaskXml(options);
  const command = `schtasks.exe /Create /TN "${taskName}" /XML "<temp_xml_path>" /F`;

  return {
    xml,
    taskName,
    command,
  };
}

// ============================================================================
// Explicit Installation and Removal (Windows only)
// ============================================================================

/**
 * Explicitly installs the task into Windows Task Scheduler.
 * NEVER executed automatically in tests or regular imports.
 */
export async function installTaskSchedule(
  options: TaskScheduleConfig = {},
  executor?: TaskScheduleExecutor,
): Promise<TaskScheduleExecutionResult> {
  const plan = planTaskSchedule(options);
  const tempXmlPath = path.join(
    os.tmpdir(),
    `harness-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xml`,
  );

  const execFn = executor?.execFileAsync || execFileAsync;

  if (process.platform !== "win32" && !executor?.execFileAsync) {
    throw new Error(
      `Cannot install Windows task on platform '${process.platform}'. Run this command on Windows with schtasks.exe.`,
    );
  }

  // Write UTF-8 XML file with BOM for Windows schtasks compatibility
  const bomBuffer = Buffer.from([0xef, 0xbb, 0xbf]);
  const xmlBuffer = Buffer.from(plan.xml, "utf-8");
  await fsPromises.writeFile(tempXmlPath, Buffer.concat([bomBuffer, xmlBuffer]));

  const args = ["/Create", "/TN", plan.taskName, "/XML", tempXmlPath, "/F"];

  try {
    const { stdout, stderr } = await execFn("schtasks.exe", args);
    const output = (stdout + "\n" + stderr).trim();
    return {
      success: true,
      taskName: plan.taskName,
      command: `schtasks.exe /Create /TN "${plan.taskName}" /XML "${tempXmlPath}" /F`,
      output,
    };
  } finally {
    try {
      if (fs.existsSync(tempXmlPath)) {
        await fsPromises.unlink(tempXmlPath);
      }
    } catch {
      // ignore temp cleanup error
    }
  }
}

/**
 * Explicitly removes the task from Windows Task Scheduler.
 * NEVER executed automatically in tests or regular imports.
 */
export async function removeTaskSchedule(
  taskName: string = "HarnessKnowledgeProducer",
  executor?: TaskScheduleExecutor,
): Promise<TaskScheduleExecutionResult> {
  const execFn = executor?.execFileAsync || execFileAsync;

  if (process.platform !== "win32" && !executor?.execFileAsync) {
    throw new Error(
      `Cannot remove Windows task on platform '${process.platform}'. Run this command on Windows with schtasks.exe.`,
    );
  }

  const args = ["/Delete", "/TN", taskName, "/F"];

  const { stdout, stderr } = await execFn("schtasks.exe", args);
  const output = (stdout + "\n" + stderr).trim();

  return {
    success: true,
    taskName,
    command: `schtasks.exe /Delete /TN "${taskName}" /F`,
    output,
  };
}

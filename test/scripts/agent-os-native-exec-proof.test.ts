import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_OS_NATIVE_EXEC_PROOF_SCHEMA_VERSION,
  createNativeExecutionProof,
  runNativeExecutionProofCli,
} from "../../scripts/agents/agent-os-native-exec-proof.mjs";

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath: string, value: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-native-exec-proof-"));
  const repoRoot = path.join(root, "repo");
  const openclawHome = path.join(root, ".openclaw");
  const toolPath = path.join(root, "tools", "safe-tool.mjs");
  writeText(
    toolPath,
    "console.log(JSON.stringify({ ok: true, envTokenVisible: process.env.SECRET_TOKEN || null }));\n",
  );
  writeJson(path.join(openclawHome, "agents_registry.json"), {
    agents: [
      {
        id: "safe_tool",
        path: toolPath,
        status: "unlisted",
        type: "python_tool",
      },
      {
        id: "missing_tool",
        path: path.join(root, "tools", "missing-tool.mjs"),
        status: "unlisted",
        type: "python_tool",
      },
    ],
  });
  return { openclawHome, repoRoot, root };
}

describe("agent os native execution proof", () => {
  it("executes one selected local implementation and emits proof contracts", async () => {
    const fixture = createFixture();
    try {
      process.env.SECRET_TOKEN = "should-not-reach-child";
      const outputPath = path.join(fixture.root, "native-proof.json");
      const agentArtifactDir = path.join(fixture.root, "agent-artifacts");
      const proof = await createNativeExecutionProof({
        agentArtifactDir,
        agentId: "safe_tool",
        generatedAt: "2026-06-02T00:00:00.000Z",
        openclawHome: fixture.openclawHome,
        outputPath,
        repoRoot: fixture.repoRoot,
        runId: "native-run",
      });
      expect(proof.schemaVersion).toBe(AGENT_OS_NATIVE_EXEC_PROOF_SCHEMA_VERSION);
      expect(proof.summary).toMatchObject({
        agentCodeExecutionProven: 1,
        failed: 0,
        selected: 1,
      });
      expect(proof.proofClaim).toMatchObject({
        allSelectedAgentCodeExecutionProven: true,
        arbitraryAgentCodeExecution: true,
        hostProcessExecution: true,
      });
      const result = proof.results[0];
      expect(result).toMatchObject({
        agentCodeExecutionProven: true,
        exitCode: 0,
        proofEvent: {
          eventType: "AGENT_NATIVE_EXECUTION_PROOF",
          status: "PASS",
        },
        ticket: {
          schemaVersion: "agent-os.ticket.v1",
          status: "DONE",
        },
      });
      const artifact = JSON.parse(
        readFileSync(path.join(agentArtifactDir, "safe_tool.json"), "utf8"),
      );
      expect(artifact.nativeExecution.stdout).toContain('"ok":true');
      expect(artifact.nativeExecution.stdout).toContain('"envTokenVisible":null');
      expect(existsSync(result.artifactContract.path)).toBe(true);
    } finally {
      delete process.env.SECRET_TOKEN;
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("fails the hard native gate when no local executable is available", async () => {
    const fixture = createFixture();
    try {
      await expect(
        runNativeExecutionProofCli([
          "prove",
          "--agent",
          "missing_tool",
          "--repo",
          fixture.repoRoot,
          "--openclaw-home",
          fixture.openclawHome,
          "--output",
          path.join(fixture.root, "missing-proof.json"),
          "--require-native",
        ]),
      ).resolves.toBe(1);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});

import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SimpleGit, simpleGit } from "simple-git";
import { v4 as uuid } from "uuid";
import * as vscode from "vscode";

async function openUrl(url: string) {
  const open = (await import("open")).default;
  await open(url);
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "quickPrMaker.makePRFromSelection",
      async () => {
        try {
          await handleMakePR({ fromSelection: true });
        } catch (error) {
          vscode.window.showErrorMessage(`Error creating PR: ${error}`);
        }
      }
    ),

    vscode.commands.registerCommand(
      "quickPrMaker.makePRFromStaged",
      async () => {
        try {
          await handleMakePR({ fromSelection: false });
        } catch (error) {
          vscode.window.showErrorMessage(`Error creating PR: ${error}`);
        }
      }
    )
  );
}

async function handleMakePR({ fromSelection }: { fromSelection: boolean }) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("No workspace folder found");
    return;
  }

  const rootPath = workspaceFolder.uri.fsPath;
  const git = simpleGit(rootPath);
  const currentBranch = await git.revparse(["--abbrev-ref", "HEAD"]);
  const config = vscode.workspace.getConfiguration("quickPrMaker");

  const commitInfo = await getCommitMessageAndBranchName(config);
  if (!commitInfo) return;

  const { message: commitMessage, branch: newBranchName } = commitInfo;
  const baseBranch = await getBaseBranch(git);

  let patch: string | null = null;
  let patchPath = path.join(os.tmpdir(), `staged-changes-${uuid()}.patch`);

  const hasUnstagedChanges = await checkIfHasUnstagedChanges(git);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: fromSelection
        ? "Creating PR from selected lines..."
        : "Creating PR from staged changes...",
      cancellable: false,
    },
    async (progress) => {
      const temp_stash_name = `temp-stash-for-pr-${uuid()}`;
      try {
        if (fromSelection) {
          console.log("Making PR from selected lines...");
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            vscode.window.showErrorMessage("No active editor");
            return;
          }

          const selection = editor.selection;
          if (selection.isEmpty) {
            vscode.window.showErrorMessage(
              "Please select the lines you want to include in the PR"
            );
            return;
          }

          const absoluteFilePath = editor.document.uri.fsPath;
          const filePath = path.relative(rootPath, absoluteFilePath);
          patch = await createPatchForSelection(
            rootPath,
            filePath,
            selection.start.line,
            selection.end.line
          );

          if (!patch) {
            vscode.window.showErrorMessage("No changes in selected lines.");
            return;
          }
          fs.writeFileSync(patchPath, patch, "utf-8");

          execGit(rootPath, `git apply --cached --verbose "${patchPath}"`);
        } else {
          console.log("Making PR from staged changes...");
          patch = execGit(rootPath, `git diff --cached`);
          if (!patch) {
            vscode.window.showErrorMessage("No changes staged.");
            return;
          }
          fs.writeFileSync(patchPath, patch, "utf-8");
        }

        if (hasUnstagedChanges) {
          console.log("Stashing unstaged changes...");
          progress.report({ message: "Stashing unstaged changes..." });
          await git.commit("Temporary commit before stash", undefined, {
            "--no-verify": null,
          });
          await git.stash(["push", "-u", "-m", temp_stash_name]);
          await git.reset(["HEAD^", "--hard"]);
        }

        progress.report({ message: "Creating new branch..." });
        console.log("Preparing new branch:", newBranchName);
        await prepareNewBranch(git, baseBranch, newBranchName);

        progress.report({ message: "Applying changes to new branch..." });
        console.log("Applying changes to new branch:", newBranchName);
        console.log("Applying patch from:", patchPath);
        console.log(fs.readFileSync(patchPath, "utf-8"));
        execGit(rootPath, `git apply --index --3way --verbose "${patchPath}"`);

        progress.report({ message: "Committing changes..." });
        await git.commit(commitMessage);

        progress.report({ message: "Pushing branch and opening PR..." });
        // await finalizePRCreation(git, newBranchName);

        await git.checkout(currentBranch);
        if (hasUnstagedChanges) {
          console.log("Popping unstaged changes...");

          const stashes = await git.stashList();
          const matchIndex = stashes.all.findIndex((s) =>
            s.message.includes(temp_stash_name)
          );

          if (matchIndex >= 0) {
            const stashRef = `stash@{${matchIndex}}`;
            console.log(`Found stash: ${stashRef}`);
            await git.stash(["pop", stashRef]);
          } else {
            console.warn("No matching stash found — skipping pop.");
          }
        }

        if (patchPath) fs.unlinkSync(patchPath);

        vscode.window.showInformationMessage(
          `PR created successfully from branch: ${newBranchName}`
        );
      } catch (error) {
        await git.checkout(currentBranch);
        const stashList = await git.stash(["list"]);
        if (hasUnstagedChanges && stashList.includes(temp_stash_name)) {
          await git.stash(["pop"]);
        }
        if (patchPath && fs.existsSync(patchPath)) {
          fs.unlinkSync(patchPath);
        }
        throw error;
      }
    }
  );
}

async function checkIfHasUnstagedChanges(
  git: SimpleGit
): Promise<boolean | null> {
  try {
    const status = await git.status();

    return (
      status.not_added.length > 0 || // new files not staged
      status.modified.length > 0 || // modified files not staged
      status.deleted.length > 0 // deleted files not staged
    );
  } catch (error) {
    console.error("Failed to check git status:", error);
    return null;
  }
}

async function getCommitMessageAndBranchName(
  config: vscode.WorkspaceConfiguration
): Promise<{ message: string; branch: string } | null> {
  const message = await vscode.window.showInputBox({
    prompt: "Enter commit message (will also be used as PR title)",
    placeHolder: "feat: something new",
  });
  if (!message) return null;

  const username = config.get<string>("githubUsername", "user") || "user";
  const branch = createBranchName(username, message);
  return { message, branch };
}

async function getBaseBranch(git: SimpleGit): Promise<string> {
  const remoteInfo = await git.raw(["remote", "show", "origin"]);
  const match = remoteInfo.match(/HEAD branch: (.+)/);
  return match ? match[1].trim() : "main";
}

async function prepareNewBranch(
  git: SimpleGit,
  baseBranch: string,
  newBranch: string
) {
  await git.checkout(baseBranch);
  await git.pull("origin", baseBranch);
  await git.checkoutBranch(newBranch, baseBranch);
}

async function finalizePRCreation(git: SimpleGit, newBranch: string) {
  await git.push(["--set-upstream", "origin", newBranch]);
  const repoInfo = await getGitHubRepoInfo(git);
  if (!repoInfo) {
    vscode.window.showErrorMessage("Failed to parse GitHub remote.");
    return;
  }

  const { org, repo } = repoInfo;
  await openUrl(`https://github.com/${org}/${repo}/pull/new/${newBranch}`);
}

async function getGitHubRepoInfo(
  git: SimpleGit
): Promise<{ org: string; repo: string } | null> {
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin || !origin.refs.fetch) return null;

  const remoteUrl = origin.refs.fetch;
  const sshMatch = remoteUrl.match(/git@github\.com:(.+?)\/(.+?)\.git/);
  const httpsMatch = remoteUrl.match(
    /https:\/\/github\.com\/(.+?)\/(.+?)\.git/
  );
  const match = sshMatch || httpsMatch;
  if (!match) return null;

  const [, org, repo] = match;
  return { org, repo };
}

function execGit(cwd: string, command: string) {
  console.log("Executing command:", command, "in", cwd);
  return child_process.execSync(command, { cwd, stdio: "pipe" }).toString();
}
async function createPatchForSelection(
  repoPath: string,
  filePath: string,
  selectionStart: number,
  selectionEnd: number
): Promise<string | null> {
  console.log("Repo Path:", repoPath);
  console.log("File Path:", filePath);
  console.log("Selection Start:", selectionStart);
  console.log("Selection End:", selectionEnd);
  const diff = execGit(repoPath, `git diff -U3 -- "${filePath}"`);

  console.log("Diff Output:", diff);
  if (!diff) return null;

  const hunks = parseDiffHunks(diff);
  const selectedHunks = hunks.filter(
    (hunk) =>
      hunk.newStart <= selectionEnd + 1 && hunk.newEnd >= selectionStart + 1
  );

  if (selectedHunks.length === 0) return null;

  const header = diff.split("\n").slice(0, 4).join("\n") + "\n";
  const patchText = header + selectedHunks.map((h) => h.text).join("\n") + "\n";
  console.log("Generated Patch Text:", patchText);
  return patchText;
}

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  newEnd: number;
  text: string;
}

function parseDiffHunks(diff: string): DiffHunk[] {
  const lines = diff.split("\n");
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let hunkLines: string[] = [];

  // Match hunk header, counts are optional
  const hunkHeaderRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const line of lines) {
    const match = hunkHeaderRegex.exec(line);
    if (match) {
      if (currentHunk) {
        currentHunk.text = hunkLines.join("\n");
        currentHunk.newEnd = currentHunk.newStart + currentHunk.newCount - 1;
        hunks.push(currentHunk);
      }
      const [, oStart, oCount, nStart, nCount] = match;
      currentHunk = {
        oldStart: parseInt(oStart, 10),
        oldCount: oCount ? parseInt(oCount, 10) : 1,
        newStart: parseInt(nStart, 10),
        newCount: nCount ? parseInt(nCount, 10) : 1,
        newEnd: 0,
        text: line,
      };
      hunkLines = [line];
    } else if (currentHunk) {
      hunkLines.push(line);
    }
  }

  if (currentHunk) {
    currentHunk.text = hunkLines.join("\n");
    currentHunk.newEnd = currentHunk.newStart + currentHunk.newCount - 1;
    hunks.push(currentHunk);
  }

  return hunks;
}

function createBranchName(username: string, commitMessage: string): string {
  const cleanMessage = commitMessage
    .substring(0, 20)
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `${username.toLowerCase()}/${cleanMessage}`;
}

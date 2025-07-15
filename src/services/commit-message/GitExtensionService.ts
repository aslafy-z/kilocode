// kilocode_change - new file
import * as vscode from "vscode"
import * as path from "path"
import { spawnSync } from "child_process"
import { shouldExcludeLockFile } from "./exclusionUtils"
import { RooIgnoreController } from "../../core/ignore/RooIgnoreController"

export interface GitChange {
	filePath: string
	status: string
}

export interface GitOptions {
	staged: boolean
}

export interface GitProgressOptions extends GitOptions {
	onProgress?: (percentage: number) => void
}

/**
 * Utility class for Git operations using direct shell commands
 */
export class GitExtensionService {
	private workspaceRoot: string | undefined
	private ignoreController: RooIgnoreController | undefined
	private targetRepository: { inputBox: { value: string }; rootUri?: vscode.Uri } | null = null
	private isInitialized: boolean = false

	constructor() {
		// Initialize with fallback workspace root
		this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

		this.updateWorkspaceContext()
	}

	/**
	 * Lazy initialization - only called when we actually need to perform git operations
	 */
	private async ensureInitialized(): Promise<boolean> {
		if (this.isInitialized) {
			return true
		}

		try {
			// Ensure we have a valid workspace root before trying git operations
			if (!this.workspaceRoot) {
				console.log(`[GitExtensionService] No workspace root available for git operations`)
				return false
			}

			// Check if git is available and we're in a git repository
			this.spawnGitWithArgs(["rev-parse", "--is-inside-work-tree"])
			this.isInitialized = true
			console.log(`[GitExtensionService] Successfully initialized with workspace: ${this.workspaceRoot}`)
			return true
		} catch (error) {
			console.error("Git initialization failed:", error)
			return false
		}
	}

	/**
	 * Public initialize method for backward compatibility
	 */
	public async initialize(): Promise<boolean> {
		return this.ensureInitialized()
	}

	/**
	 * Configures the repository context for multi-workspace scenarios
	 */
	public configureRepositoryContext(resourceUri?: vscode.Uri): void {
		if (resourceUri) {
			const newTargetRepository = this.determineTargetRepository(resourceUri)
			if (newTargetRepository && newTargetRepository !== this.targetRepository) {
				this.targetRepository = newTargetRepository
				this.updateWorkspaceContext()
			}
		}
	}

	private determineTargetRepository(
		resourceUri: vscode.Uri,
	): { inputBox: { value: string }; rootUri?: vscode.Uri } | null {
		try {
			const gitExtension = vscode.extensions.getExtension("vscode.git")
			if (!gitExtension || !gitExtension.isActive) {
				return null
			}

			const gitApi = gitExtension?.exports.getAPI(1)
			for (const repo of gitApi?.repositories ?? []) {
				if (repo.rootUri && resourceUri.fsPath.startsWith(repo.rootUri.fsPath)) {
					return repo
				}
			}

			return gitApi.repositories[0] // Fallback to first repository
		} catch (error) {
			console.error("Error determining target repository:", error)
			return null
		}
	}

	/**
	 * Updates the workspace context when the target repository changes
	 */
	private updateWorkspaceContext(): void {
		if (!this.targetRepository?.rootUri) {
			return
		}

		const newWorkspaceRoot = this.targetRepository.rootUri.fsPath
		console.log(
			`[GitExtensionService] updateWorkspaceContext - New workspace root: ${newWorkspaceRoot}, Current: ${this.workspaceRoot}`,
		)

		if (newWorkspaceRoot !== this.workspaceRoot) {
			this.ignoreController?.dispose()
			this.workspaceRoot = newWorkspaceRoot

			// Reset initialization flag since workspace changed
			this.isInitialized = false

			// Create new ignore controller with the updated workspace root
			this.ignoreController = new RooIgnoreController(this.workspaceRoot)
			this.ignoreController.initialize()
		}
	}

	/**
	 * Gathers information about changes (staged or unstaged)
	 */
	public async gatherChanges(options: GitProgressOptions): Promise<GitChange[]> {
		try {
			// Ensure git is initialized before performing operations
			const initialized = await this.ensureInitialized()
			if (!initialized) {
				return []
			}

			const statusOutput = this.getStatus(options)
			if (!statusOutput.trim()) {
				return []
			}

			const changes: GitChange[] = []
			const lines = statusOutput.split("\n").filter((line: string) => line.trim())

			for (const line of lines) {
				if (line.length < 2) continue

				const statusCode = line.substring(0, 1).trim()
				const filePath = line.substring(1).trim()

				changes.push({
					filePath: path.join(this.workspaceRoot || process.cwd(), filePath),
					status: this.getChangeStatusFromCode(statusCode),
				})
			}

			return changes
		} catch (error) {
			const changeType = options.staged ? "staged" : "unstaged"
			console.error(`Error gathering ${changeType} changes:`, error)
			return []
		}
	}

	/**
	 * Sets the commit message in the Git input box
	 */
	public setCommitMessage(message: string): void {
		if (this.targetRepository) {
			this.targetRepository.inputBox.value = message
			return
		}

		// Fallback to clipboard if VS Code Git Extension API is not available
		this.copyToClipboardFallback(message)
	}

	/**
	 * Runs a git command with arguments and returns the output
	 * @param args The git command arguments as an array
	 * @returns The command output as a string
	 */
	public spawnGitWithArgs(args: string[]): string {
		try {
			if (!this.workspaceRoot) {
				return ""
			}

			const result = spawnSync("git", args, {
				cwd: this.workspaceRoot,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			})

			if (result.error) {
				throw result.error
			}

			if (result.status !== 0) {
				throw new Error(`Git command failed with status ${result.status}: ${result.stderr}`)
			}

			return result.stdout
		} catch (error) {
			console.error(`Error executing git command: git ${args.join(" ")}`, error)
			throw error
		}
	}

	private async getDiffForChanges(options: GitProgressOptions): Promise<string> {
		const { staged, onProgress } = options
		try {
			const diffs: string[] = []
			const args = staged ? ["diff", "--name-only", "--cached"] : ["diff", "--name-only"]
			const files = this.spawnGitWithArgs(args)
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)

			let processedFiles = 0
			for (const filePath of files) {
				if (this.ignoreController?.validateAccess(filePath) && !shouldExcludeLockFile(filePath)) {
					const diff = this.getGitDiff(filePath, { staged }).trim()
					diffs.push(diff)
				}

				processedFiles++
				if (onProgress && files.length > 0) {
					const percentage = (processedFiles / files.length) * 100
					onProgress(percentage)
				}
			}

			return diffs.join("\n")
		} catch (error) {
			const changeType = staged ? "staged" : "unstaged"
			console.error(`Error generating ${changeType} diff:`, error)
			return ""
		}
	}

	private getStatus(options: GitOptions): string {
		const { staged } = options
		const args = staged ? ["diff", "--name-status", "--cached"] : ["diff", "--name-status"]
		return this.spawnGitWithArgs(args)
	}

	private getSummary(options: GitOptions): string {
		const { staged } = options
		const args = staged ? ["diff", "--cached", "--stat"] : ["diff", "--stat"]
		return this.spawnGitWithArgs(args)
	}

	private getGitDiff(filePath: string, options: GitOptions): string {
		const { staged } = options
		const args = staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath]
		return this.spawnGitWithArgs(args)
	}

	private getCurrentBranch(): string {
		return this.spawnGitWithArgs(["branch", "--show-current"])
	}

	private getRecentCommits(count: number = 5): string {
		return this.spawnGitWithArgs(["log", "--oneline", `-${count}`])
	}

	/**
	 * Gets all context needed for commit message generation
	 */
	public async getCommitContext(changes: GitChange[], options: GitProgressOptions): Promise<string> {
		const { staged } = options
		try {
			// Ensure git is initialized before performing operations
			const initialized = await this.ensureInitialized()
			if (!initialized) {
				return "## Git Context for Commit Message Generation\n\n(Git not available)\n"
			}
			// Start building the context with the required sections
			let context = "## Git Context for Commit Message Generation\n\n"

			// Add full diff - essential for understanding what changed
			try {
				const diff = await this.getDiffForChanges(options)
				const changeType = staged ? "Staged" : "Unstaged"
				context += `### Full Diff of ${changeType} Changes\n\`\`\`diff\n` + diff + "\n```\n\n"
			} catch (error) {
				const changeType = staged ? "Staged" : "Unstaged"
				context += `### Full Diff of ${changeType} Changes\n\`\`\`diff\n(No diff available)\n\`\`\`\n\n`
			}

			// Add statistical summary - helpful for quick overview
			try {
				const summary = this.getSummary(options)
				context += "### Statistical Summary\n```\n" + summary + "\n```\n\n"
			} catch (error) {
				context += "### Statistical Summary\n```\n(No summary available)\n```\n\n"
			}

			// Add contextual information
			context += "### Repository Context\n\n"

			// Show current branch
			try {
				const currentBranch = this.getCurrentBranch()
				if (currentBranch) {
					context += "**Current branch:** `" + currentBranch.trim() + "`\n\n"
				}
			} catch (error) {
				// Skip if not available
			}

			// Show recent commits for context
			try {
				const recentCommits = this.getRecentCommits()
				if (recentCommits) {
					context += "**Recent commits:**\n```\n" + recentCommits + "\n```\n"
				}
			} catch (error) {
				// Skip if not available
			}

			return context
		} catch (error) {
			console.error("Error generating commit context:", error)
			return "## Error generating commit context\n\nUnable to gather complete context for commit message generation."
		}
	}

	/**
	 * Fallback method to copy commit message to clipboard
	 * @private Helper method for setCommitMessage
	 */
	private copyToClipboardFallback(message: string): void {
		try {
			vscode.env.clipboard.writeText(message)
			vscode.window.showInformationMessage(
				"Commit message copied to clipboard. Paste it into the commit message field.",
			)
		} catch (clipboardError) {
			console.error("Error copying to clipboard:", clipboardError)
			throw new Error("Failed to set commit message")
		}
	}

	/**
	 * Converts Git status code to readable text
	 */
	private getChangeStatusFromCode(code: string): string {
		switch (code) {
			case "M":
				return "Modified"
			case "A":
				return "Added"
			case "D":
				return "Deleted"
			case "R":
				return "Renamed"
			case "C":
				return "Copied"
			case "U":
				return "Updated"
			case "?":
				return "Untracked"
			default:
				return "Unknown"
		}
	}

	public dispose() {
		this.ignoreController?.dispose()
	}
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as vscode from "vscode"
import { GitExtensionService } from "../GitExtensionService"
import { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"

// Mock VSCode
vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [
			{
				uri: {
					fsPath: "/original/workspace",
				},
			},
		],
	},
	extensions: {
		getExtension: vi.fn(),
	},
	Uri: {
		file: vi.fn((path: string) => ({ fsPath: path })),
	},
}))

// Mock RooIgnoreController
vi.mock("../../../core/ignore/RooIgnoreController", () => ({
	RooIgnoreController: vi.fn().mockImplementation((workspaceRoot: string) => ({
		initialize: vi.fn(),
		dispose: vi.fn(),
		validateAccess: vi.fn().mockReturnValue(true),
		workspaceRoot,
	})),
}))

// Mock child_process
vi.mock("child_process", () => ({
	spawnSync: vi.fn().mockReturnValue({
		status: 0,
		stdout: "test output",
		stderr: "",
	}),
}))

describe("GitExtensionService - Multi-workspace Support", () => {
	let service: GitExtensionService
	let mockGitExtension: any
	let mockGitApi: any
	let mockRepository: any

	beforeEach(() => {
		mockRepository = {
			rootUri: { fsPath: "/new/workspace" },
			inputBox: { value: "" },
		}

		mockGitApi = {
			repositories: [mockRepository],
		}

		mockGitExtension = {
			isActive: true,
			exports: {
				getAPI: vi.fn().mockReturnValue(mockGitApi),
			},
		}

		vi.mocked(vscode.extensions.getExtension).mockReturnValue(mockGitExtension)

		service = new GitExtensionService()
	})

	afterEach(() => {
		service.dispose()
		vi.clearAllMocks()
		// Reset the RooIgnoreController mock specifically
		vi.mocked(RooIgnoreController).mockClear()
	})

	it("should update workspace root when target repository changes", () => {
		// Debug: Check if the service has an ignore controller
		console.log("Service ignoreController:", (service as any).ignoreController)
		console.log("Service workspaceRoot:", (service as any).workspaceRoot)

		// Debug: Check mock calls
		const mockCalls = vi.mocked(RooIgnoreController).mock.calls
		console.log("Mock calls before configureRepositoryContext:", mockCalls)

		// Create a resource URI that matches the mock repository
		const resourceUri = vscode.Uri.file("/new/workspace/some/file.ts")

		// Configure repository context
		service.configureRepositoryContext(resourceUri)

		// Should be called once when workspace changes (constructor doesn't create controller without targetRepository)
		expect(vi.mocked(RooIgnoreController)).toHaveBeenCalledTimes(1)
		expect(vi.mocked(RooIgnoreController)).toHaveBeenCalledWith("/new/workspace")
	})

	it("should dispose old ignore controller when workspace changes", () => {
		// First, configure a repository to create an ignore controller
		const firstResourceUri = vscode.Uri.file("/first/workspace/file.ts")
		service.configureRepositoryContext(firstResourceUri)

		// Get reference to the first ignore controller
		const firstController = (service as any).ignoreController
		expect(firstController).toBeDefined()
		const disposeSpy = vi.spyOn(firstController, "dispose")

		// Mock a different repository for the second workspace
		const secondMockRepo = {
			inputBox: { value: "second-repo" },
			rootUri: vscode.Uri.file("/second/workspace"),
		}
		mockGitApi.repositories = [secondMockRepo as any]

		// Configure a different workspace to trigger disposal
		const secondResourceUri = vscode.Uri.file("/second/workspace/file.ts")
		service.configureRepositoryContext(secondResourceUri)

		// Verify old controller was disposed
		expect(disposeSpy).toHaveBeenCalledOnce()

		// Verify new controller was created
		expect((service as any).ignoreController).not.toBe(firstController)
		expect((service as any).workspaceRoot).toBe("/second/workspace")
	})

	it("should not update workspace if target repository is the same", () => {
		const resourceUri = vscode.Uri.file("/new/workspace/some/file.ts")

		// Configure repository context twice with same URI
		service.configureRepositoryContext(resourceUri)
		service.configureRepositoryContext(resourceUri)

		// Should only create controller once (for first change, not duplicated)
		expect(vi.mocked(RooIgnoreController)).toHaveBeenCalledTimes(1)
	})

	it("should handle missing rootUri gracefully", () => {
		// Create a new service instance to reset the mock call count
		const newService = new GitExtensionService()

		// Mock repository without rootUri
		const repositoryWithoutRoot = {
			inputBox: { value: "" },
		}
		mockGitApi.repositories = [repositoryWithoutRoot]
		const resourceUri = vscode.Uri.file("/some/file.ts")

		expect(() => {
			newService.configureRepositoryContext(resourceUri)
		}).not.toThrow()

		// Should not create controller when rootUri is missing
		expect(vi.mocked(RooIgnoreController)).not.toHaveBeenCalled()

		newService.dispose()
	})
})

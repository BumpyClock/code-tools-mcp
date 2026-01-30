// ABOUTME: Manages multiple workspace directories and validates paths against them.

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

export interface AddDirectoriesResult {
	added: string[];
	failed: Array<{ path: string; error: Error }>;
}

export class WorkspaceContext {
	private directories = new Set<string>();
	private initialDirectories: Set<string>;

	constructor(
		readonly targetDir: string,
		additionalDirectories: string[] = [],
	) {
		this.addDirectorySync(targetDir);
		this.addDirectoriesSync(additionalDirectories);
		this.initialDirectories = new Set(this.directories);
	}

	async addDirectory(directory: string): Promise<void> {
		const result = await this.addDirectories([directory]);
		if (result.failed.length > 0) {
			throw result.failed[0]?.error;
		}
	}

	async addDirectories(directories: string[]): Promise<AddDirectoriesResult> {
		const result: AddDirectoriesResult = { added: [], failed: [] };
		for (const directory of directories) {
			try {
				const resolved = await this.resolveAndValidateDir(directory);
				this.directories.add(resolved);
				result.added.push(directory);
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				result.failed.push({ path: directory, error });
			}
		}
		return result;
	}

	setDirectories(directories: readonly string[]): void {
		const next = new Set<string>();
		for (const dir of directories) {
			next.add(this.resolveAndValidateDirSync(dir));
		}
		this.directories = next;
	}

	getDirectories(): readonly string[] {
		return Array.from(this.directories);
	}

	getInitialDirectories(): readonly string[] {
		return Array.from(this.initialDirectories);
	}

	isPathWithinWorkspace(pathToCheck: string): boolean {
		try {
			const fullyResolved = this.fullyResolvedPath(pathToCheck);
			for (const dir of this.directories) {
				if (this.isPathWithinRoot(fullyResolved, dir)) return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	private addDirectorySync(directory: string): void {
		const result = this.addDirectoriesSync([directory]);
		if (result.failed.length > 0) {
			throw result.failed[0]?.error;
		}
	}

	private addDirectoriesSync(directories: string[]): AddDirectoriesResult {
		const result: AddDirectoriesResult = { added: [], failed: [] };
		for (const directory of directories) {
			try {
				const resolved = this.resolveAndValidateDirSync(directory);
				this.directories.add(resolved);
				result.added.push(directory);
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				result.failed.push({ path: directory, error });
			}
		}
		return result;
	}

	private async resolveAndValidateDir(directory: string): Promise<string> {
		const absolutePath = path.resolve(this.targetDir, directory);
		try {
			await fsPromises.access(absolutePath);
		} catch {
			throw new Error(`Directory does not exist: ${absolutePath}`);
		}
		const stats = await fsPromises.stat(absolutePath);
		if (!stats.isDirectory()) {
			throw new Error(`Path is not a directory: ${absolutePath}`);
		}
		return fsPromises.realpath(absolutePath);
	}

	private resolveAndValidateDirSync(directory: string): string {
		const absolutePath = path.resolve(this.targetDir, directory);
		if (!fs.existsSync(absolutePath)) {
			throw new Error(`Directory does not exist: ${absolutePath}`);
		}
		const stats = fs.statSync(absolutePath);
		if (!stats.isDirectory()) {
			throw new Error(`Path is not a directory: ${absolutePath}`);
		}
		return fs.realpathSync(absolutePath);
	}

	private fullyResolvedPath(pathToCheck: string): string {
		const resolved = path.resolve(this.targetDir, pathToCheck);
		try {
			return fs.realpathSync(resolved);
		} catch (err) {
			const error = err as NodeJS.ErrnoException;
			if (error.code === "ENOENT" && error.path) {
				return error.path;
			}
			throw err;
		}
	}

	private isPathWithinRoot(
		pathToCheck: string,
		rootDirectory: string,
	): boolean {
		const relative = path.relative(rootDirectory, pathToCheck);
		return (
			!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative)
		);
	}
}

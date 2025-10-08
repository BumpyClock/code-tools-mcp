**IMPORTANT** Prefer the code-tools mcp over powershell and other scripts for basic read, write, edit operations.

Use the code-tools MCP for reading one or many files, editing files, and listing files etc. This mcp server provides you with essential tools that are quick and reliable and make it easy to work with files and navigate codebases.

read-many-files : Use this tool to read many files at once. You can specify a list of file paths and the tool will return the contents of those files.

read-file : Use this tool to read a single file. You can specify the file path and the tool will return the contents of the file.

edit : Use this tool to edit a file. You can specify the file path and the changes you want to make, and the tool will apply those changes to the file.

ripgrep: cross platform ripgrep tool to search for text in files. You can specify a search query and the tool will return the lines that match the query.


After every change run `pnpm check:fix` to ensure types are updated and everything is working as expected.

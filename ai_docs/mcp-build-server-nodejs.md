# Building an MCP Weather Server with Node.js

## Prerequisites

### System Requirements
- Latest version of Node.js installed
- Familiarity with TypeScript and LLMs like Claude

### Logging Best Practices
- Avoid writing to standard output (stdout) for STDIO-based servers
- Use logging libraries that write to stderr or files
- Be careful with `console.log()` in JavaScript

## Project Setup

### Installation Steps
1. Create project directory
2. Initialize npm project
3. Install dependencies:
   - `@modelcontextprotocol/sdk`
   - `zod`
   - TypeScript dev dependencies

### Configuration
- Update `package.json` to add:
  - `"type": "module"`
  - Build scripts
  - Create `tsconfig.json`

## Server Implementation

### Key Components
- Import necessary packages
- Create server instance
- Implement helper functions for API requests
- Define tool execution handlers

### Code Structure
```typescript
// Server initialization
const server = new McpServer({
  name: "weather",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Helper functions for API requests
async function makeNWSRequest<T>(url: string): Promise<T | null> {
  // Fetch and handle NWS API requests
}

// Tool implementation for weather alerts
server.tool(
  "get_alerts",
  "Get weather alerts for a state",
  // Tool input schema and execution logic
);

// Tool implementation for weather forecast
server.tool(
  "get_forecast",
  "Get weather forecast for a location",
  // Tool input schema and execution logic
);
```

## Testing with Claude for Desktop

### Configuration Steps
1. Open `claude_desktop_config.json`
2. Add server configuration
3. Restart Claude for Desktop

### Example Configuration
```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/weather/build/index.js"]
    }
  }
}
```

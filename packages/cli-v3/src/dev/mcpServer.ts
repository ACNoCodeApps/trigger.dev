import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { optional, union, z } from "zod";
import { logger } from "../utilities/logger.js";
import { CliApiClient } from "../apiClient.js";
import { ApiClient, RunStatus } from "@trigger.dev/core/v3";
import polka from "polka";

let projectRef: string;
let dashboardUrl: string;
// there is some overlap between `ApiClient` and `CliApiClient` which is not ideal
// we can address in this in the future, but for now we need keep using both
// as `ApiClient` exposes most of the methods needed for the MCP tools
let sdkApiClient: ApiClient;

let mcpTransport: SSEServerTransport | null = null;

const server = new McpServer({
  name: "trigger.dev",
  version: "1.0.0",
});

server.tool(
  "trigger-task",
  "Trigger a task",
  {
    id: z.string().describe("The ID of the task to trigger"),
    payload: z
      .string()
      .transform((val, ctx) => {
        try {
          return JSON.parse(val);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "The payload must be a valid JSON string",
          });
          return z.NEVER;
        }
      })
      .describe("The payload to pass to the task run, must be a valid JSON"),
    // TODO: expose more parameteres from the trigger options
  },
  async ({ id, payload }) => {
    const result = await sdkApiClient.triggerTask(id, {
      payload,
    });

    const taskRunUrl = `${dashboardUrl}/projects/v3/${projectRef}/runs/${result.id}`;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...result, taskRunUrl }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "list-runs",
  "List task runs. This returns a paginated list which shows the details of the runs, e.g., status, attempts, cost, etc.",
  {
    filters: z
      .object({
        status: RunStatus.optional().describe(
          "The status of the run. Can be WAITING_FOR_DEPLOY, QUEUED, EXECUTING, REATTEMPTING, or FROZEN"
        ),
        taskIdentifier: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe("The identifier of the task that was run"),
        version: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe("The version of the worker that executed the run"),
        from: z
          .union([z.date(), z.number()])
          .optional()
          .describe("Start date/time for filtering runs"),
        to: z.union([z.date(), z.number()]).optional().describe("End date/time for filtering runs"),
        period: z.string().optional().describe("Time period for filtering runs"),
        bulkAction: z
          .string()
          .optional()
          .describe("The bulk action ID to filter the runs by (e.g., bulk_1234)"),
        tag: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe("The tags that are attached to the run"),
        schedule: z
          .string()
          .optional()
          .describe("The schedule ID to filter the runs by (e.g., schedule_1234)"),
        isTest: z.boolean().optional().describe("Whether the run is a test run or not"),
        batch: z.string().optional().describe("The batch identifier to filter runs by"),
      })
      .describe("Parameters for listing task runs"),
  },
  async ({ filters }) => {
    const { data, pagination } = await sdkApiClient.listRuns(filters);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ data, pagination }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "get-run",
  "Retrieve the details of a task run, e.g., status, attempts, cost, etc.",
  {
    runId: z.string().describe("The ID of the task run to get"),
  },
  async ({ runId }) => {
    const result = await sdkApiClient.retrieveRun(runId);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

const app = polka();
app.get("/sse", (_req, res) => {
  mcpTransport = new SSEServerTransport("/messages", res);
  server.connect(mcpTransport);
});
app.post("/messages", (req, res) => {
  if (mcpTransport) {
    mcpTransport.handlePostMessage(req, res);
  }
});

export const startMcpServer = async (options: {
  port: number;
  cliApiClient: CliApiClient;
  devSession: {
    dashboardUrl: string;
    projectRef: string;
  };
}) => {
  const { apiURL, accessToken } = options.cliApiClient;

  if (!accessToken) {
    logger.error("No access token found in the API client, failed to start the MCP server");
    return;
  }

  sdkApiClient = new ApiClient(apiURL, accessToken);
  projectRef = options.devSession.projectRef;
  dashboardUrl = options.devSession.dashboardUrl;

  app.listen(options.port, () => {
    logger.info(`Trigger.dev MCP Server is now running on port ${options.port} ✨`);
  });
};

export const stopMcpServer = () => {
  app.server?.close(() => {
    logger.info(`Trigger.dev MCP Server is now stopped`);
  });
};

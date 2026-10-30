import { describe, expect, test } from "vitest";
import {
  Agent,
  definePlaygroundAPI,
  definePlaygroundActions,
  definePlaygroundQueries,
  type PlaygroundAgentInfo,
} from "../index.js";
import { mockModel } from "./mockModel.js";
import { app, components } from "./setup.test.js";

const info: PlaygroundAgentInfo = {
  name: "node-agent",
  instructions: "Runs in Node.",
  contextOptions: { recentMessages: 5 },
  tools: ["fetchThing"],
};
const agent = new Agent(components.agent, {
  name: info.name,
  instructions: "Runs anywhere.",
  languageModel: mockModel({
    content: [{ type: "text", text: "hello from the split" }],
  }),
});
const { listAgents: listAgentsFromInfos, createThread } =
  definePlaygroundQueries(components.agent, {
    agents: [info, { name: "bare" }],
  });
const { generateText: generateTextSplit } = definePlaygroundActions(
  components.agent,
  { agents: [agent] },
);
const reasoningAgent = new Agent(components.agent, {
  name: "reasoning-agent",
  languageModel: mockModel({
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "answer" },
    ],
  }),
});
const { generateText: generateTextReasoning } = definePlaygroundActions(
  components.agent,
  { agents: [reasoningAgent] },
);
const { listAgents: listAgentsCombined } = definePlaygroundAPI(
  components.agent,
  { agents: () => [agent] },
);

const { api, createTest } = app.defineModules({
  playground: {
    listAgentsFromInfos,
    listAgentsCombined,
    generateTextSplit,
    generateTextReasoning,
    createThread,
  },
});

describe("split playground API", () => {
  test("queries list agents from metadata alone, in the shape the playground expects", async () => {
    const t = createTest();
    const apiKey = await t.mutation(components.agent.apiKeys.issue, {});
    expect(
      await t.query(api.playground.listAgentsFromInfos, { apiKey }),
    ).toStrictEqual([info, { name: "bare", tools: [] }]);
  });

  test("actions defined on their own run the agent", async () => {
    const t = createTest();
    const apiKey = await t.mutation(components.agent.apiKeys.issue, {});
    const [{ name: agentName }] = await t.query(
      api.playground.listAgentsFromInfos,
      {
        apiKey,
      },
    );
    const { threadId } = await t.mutation(api.playground.createThread, {
      apiKey,
      userId: "u",
    });
    const result = await t.action(api.playground.generateTextSplit, {
      apiKey,
      agentName,
      userId: "u",
      threadId,
      prompt: "hi",
    });
    expect(result.text).toBe("hello from the split");
  });

  test("generateText returns derived reasoning fields (#418)", async () => {
    const t = createTest();
    const apiKey = await t.mutation(components.agent.apiKeys.issue, {});
    const { threadId } = await t.mutation(api.playground.createThread, {
      apiKey,
      userId: "u",
    });
    const result = await t.action(api.playground.generateTextReasoning, {
      apiKey,
      agentName: reasoningAgent.options.name,
      userId: "u",
      threadId,
      prompt: "hi",
    });
    expect(result.messages.at(-1)).toMatchObject({
      reasoning: "thinking",
      reasoningDetails: [{ type: "reasoning", text: "thinking" }],
    });
  });

  test("combined API lists agent instances from a callback", async () => {
    const t = createTest();
    const apiKey = await t.mutation(components.agent.apiKeys.issue, {});
    expect(
      await t.query(api.playground.listAgentsCombined, { apiKey }),
    ).toMatchObject([{ name: info.name, tools: [] }]);
    await t.mutation(components.agent.apiKeys.destroy, { apiKey });
    await expect(
      t.query(api.playground.listAgentsCombined, { apiKey }),
    ).rejects.toThrow();
  });
});

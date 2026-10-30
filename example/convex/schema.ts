import { defineSchema } from "convex/server";
import ragTables from "./rag/tables.js";
import usageTables from "./usage_tracking/tables.js";
import batchTables from "./batch/tables.js";

export default defineSchema({
  ...ragTables,
  ...usageTables,
  ...batchTables,
});

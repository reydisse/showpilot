import { z } from "zod";
import { idSchema } from "./validation";
import { genericSettingKeySchema } from "./editable-settings";
import { isCredentialField } from "./credential-fields";

export const settingWriteSchema = z.object({
  orgId: idSchema,
  key: genericSettingKeySchema.refine(key => !isCredentialField(key), "Use the dedicated credential editor."),
  value: z.string().max(200_000),
  expectedValue: z.string().max(200_000).nullable(),
  requestId: z.uuid(),
});
export type SettingWrite = z.infer<typeof settingWriteSchema>;
export type SettingChange = Omit<SettingWrite, "orgId">;
export type SettingWriteResult = {
  requestId: string;
  key: string;
  outcome: "applied" | "conflict";
  currentValue: string | null;
};

import { useMobileTeam } from "@/hooks/use-mobile-team";
import { teamRetryable, type TeamDraft } from "@/lib/team-recovery";
import { useMobileAssignment } from "@/hooks/use-mobile-assignment";
import { assignmentFieldsSchema, assignmentRetryable, type AssignmentDraft, type AssignmentRead, type ScheduleAssignmentCommand, type ScheduleAssignmentResult } from "@/lib/assignment-recovery";
import { reminderMessage } from "@/lib/reminder-recovery";
import { useMobileInventory } from "@/hooks/use-mobile-inventory";
import type { InventoryCommand, InventoryResult, InventoryDraft } from "@/lib/inventory-recovery";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/providers/workspace-provider";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Check from "lucide-react-native/icons/check";
import Search from "lucide-react-native/icons/search";
import X from "lucide-react-native/icons/x";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { Page } from "@/components/page";
import type { MobileSchedule } from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

type Crew = MobileSchedule["crew"][number];

function ScheduleSheet({ children, onClose, title, eyebrow }: {
  children: ReactNode;
  onClose: () => void;
  title: string;
  eyebrow: string;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <Page scroll={false}>
        <View style={styles.header}>
          <View style={styles.headerCopy}><Text style={styles.eyebrow}>{eyebrow}</Text><Text style={styles.title}>{title}</Text></View>
          <Pressable accessibilityLabel={`Close ${title}`} accessibilityRole="button" onPress={onClose} style={styles.close}><X color={colors.textMuted} size={21} /></Pressable>
        </View>
        <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </Page>
    </Modal>
  );
}

function CrewPicker({ crew, selectedId, onSelect, disabled = false }: {
  disabled?: boolean;
  crew: Crew[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return crew.filter((person) => !needle || `${person.name} ${person.role} ${person.email}`.toLowerCase().includes(needle)).slice(0, 50);
  }, [crew, search]);
  return (
    <View style={styles.picker}>
      <Text style={styles.fieldLabel}>ROSTER CONTACT</Text>
      <View style={styles.search}><Search color={colors.textFaint} size={15} /><TextInput accessibilityLabel="Search roster" editable={!disabled} onChangeText={setSearch} placeholder="Search name or role" placeholderTextColor={colors.textFaint} style={styles.searchInput} value={search} /></View>
      <Pressable accessibilityRole="radio" accessibilityState={{ checked: selectedId === null, disabled }} disabled={disabled} onPress={() => onSelect(null)} style={[styles.choice, selectedId === null && styles.choiceActive]}>
        <View style={styles.choiceCopy}><Text style={styles.choiceName}>Open position</Text><Text style={styles.choiceMeta}>Nobody assigned yet</Text></View>
        {selectedId === null ? (
          <Check color={colors.amberText} size={17} />
        ) : null}
      </Pressable>
      {selectedId && !crew.some(person => person.id === selectedId) ? <Text style={styles.hint}>The selected roster contact is unavailable. Your selection is retained.</Text> : null}
      {filtered.map((person) => (
        <Pressable accessibilityRole="radio" accessibilityState={{ checked: selectedId === person.id, disabled: disabled || !person.email }} disabled={disabled || !person.email} key={person.id} onPress={() => onSelect(person.id)} style={[styles.choice, selectedId === person.id && styles.choiceActive, !person.email && styles.choiceDisabled]}>
          <View style={styles.choiceCopy}><Text style={styles.choiceName}>{person.name}</Text><Text style={styles.choiceMeta}>{person.role || "Crew"}{person.email ? ` · ${person.email}` : " · Email required"}</Text></View>
          {selectedId === person.id ? (
            <Check color={colors.amberText} size={17} />
          ) : null}
        </Pressable>
      ))}
      {crew.length > 50 && !search ? (
        <Text style={styles.hint}>Search to find more roster contacts.</Text>
      ) : null}
    </View>
  );
}

export function ScheduleAssignmentSheet({
  orgId,
  userId,
  active,
  initial,
  crew,
  onClose,
  onCommand,
  onRead,
  onRefresh,
}: {
  orgId: string;
  userId: string;
  active: boolean;
  initial: AssignmentDraft;
  crew: Crew[];
  onClose: () => void;
  onCommand: (
    command: ScheduleAssignmentCommand,
    review: boolean,
    signal: AbortSignal,
  ) => Promise<ScheduleAssignmentResult>;
  onRead: (
    orgId: string,
    id: string,
    signal: AbortSignal,
  ) => Promise<AssignmentRead>;
  onRefresh: (signal: AbortSignal) => Promise<void>;
}) {
  const styles = useStyles();
  const work = useMobileAssignment({ orgId, userId }, initial, {
    active,
    send: onCommand,
    read: onRead,
    refresh: onRefresh,
  });
  const { draft, attempt } = work;
  const [confirm, setConfirm] = useState<"save" | "discard" | null>(null);
  useEffect(() => {
    setConfirm(null);
  }, [active, orgId, userId, initial.editorId]);
  const fields = draft.fields;
  const removing = draft.mode === "delete";
  const locked = work.locked || !!confirm || !active || removing;
  const personChanged =
    fields.crewMemberId !== (draft.base?.crewMemberId ?? null);
  const replacingDecline = draft.base?.status === "declined" && personChanged;
  const valid =
    (removing || assignmentFieldsSchema.safeParse(fields).success) &&
    (draft.mode === "create" || !!draft.base?.revision);
  const change = <K extends keyof AssignmentDraft["fields"]>(
    key: K,
    value: AssignmentDraft["fields"][K],
  ) => {
    if (!locked)
      work.setDraft((current) => ({
        ...current,
        fields: { ...current.fields, [key]: value },
      }));
  };
  const submit = () => {
    if (!active || work.locked || !valid) return;
    if (removing || (draft.base?.status === "confirmed" && personChanged))
      setConfirm("save");
    else work.submit();
  };
  const result =
    attempt?.kind === "confirmed" ? attempt.result : attempt?.previous;
  const settled = attempt?.kind === "confirmed" && attempt.refresh === "done";
  return (
    <ScheduleSheet
      eyebrow={
        removing
          ? "REMOVE ASSIGNMENT"
          : draft.mode === "edit"
            ? "EDIT ASSIGNMENT"
            : "NEW POSITION"
      }
      onClose={onClose}
      title={draft.base ? fields.role : "Add a position"}
    >
      <Text style={styles.intro}>
        {draft.showName} · {fields.serviceDate} · {fields.timeZone}
      </Text>
      <Text style={styles.assignmentCopy}>
        Closing keeps this draft and any unconfirmed save until you return.
        Signing out or restarting the app clears local drafts.
      </Text>
      {draft.base ? (
        <View style={styles.responseBox}>
          <Text style={styles.responseLabel}>LAST REVIEWED RESPONSE</Text>
          <Text style={styles.responseValue}>
            {draft.base.crewMemberId ? draft.base.status : "Open position"}
          </Text>
          {draft.base.responseNote ? (
            <Text style={styles.responseNote}>{draft.base.responseNote}</Text>
          ) : null}
        </View>
      ) : null}
      <AppField
        editable={!locked}
        autoCapitalize="words"
        label="Position"
        maxLength={120}
        onChangeText={(value) => change("role", value)}
        placeholder="Camera Operator"
        value={fields.role}
      />
      <AppField
        editable={!locked}
        autoCapitalize="words"
        label="Department"
        maxLength={80}
        onChangeText={(value) => change("department", value)}
        placeholder="Video"
        value={fields.department}
      />
      <CrewPicker
        disabled={locked}
        crew={crew}
        onSelect={(value) => change("crewMemberId", value)}
        selectedId={fields.crewMemberId}
      />
      <AppField
        editable={!locked}
        autoCapitalize="none"
        error={
          fields.callTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(fields.callTime)
            ? "Use 24-hour HH:mm."
            : undefined
        }
        keyboardType="numbers-and-punctuation"
        label="Custom call time (optional)"
        maxLength={5}
        onChangeText={(value) => change("callTime", value)}
        placeholder="08:15"
        value={fields.callTime}
      />
      <AppField
        editable={!locked}
        autoCapitalize="sentences"
        label="Manager note (optional)"
        maxLength={500}
        multiline
        onChangeText={(value) => change("notes", value)}
        placeholder="Arrival instructions or preparation notes"
        style={styles.notes}
        textAlignVertical="top"
        value={fields.notes}
      />
      {work.error ? (
        <Text accessibilityRole="alert" style={styles.assignmentCopy}>
          {work.error}
        </Text>
      ) : null}
      {work.reading ? (
        <Text style={styles.assignmentCopy}>Loading current position…</Text>
      ) : null}
      {!attempt && !confirm ? (
        <>
          <Text style={styles.assignmentCopy}>
            {removing
              ? "Removing this position closes its pending invitation. You will confirm before removal."
              : replacingDecline
                ? "Saving creates a replacement position and preserves the declined response."
                : fields.crewMemberId
                  ? personChanged
                    ? "Saving sends a new secure invitation and resets any earlier response."
                    : "Role and note edits preserve the existing response."
                  : "This remains visible as an open position."}
          </Text>
          {draft.base && !draft.base.revision ? (
            <AppButton
              disabled={!active || work.reading}
              label="Load current position"
              onPress={work.loadCurrent}
            />
          ) : null}
          <AppButton
            disabled={!valid || work.locked || !active}
            label={
              removing
                ? "Review removal"
                : draft.mode === "edit"
                  ? "Save assignment"
                  : fields.crewMemberId
                    ? "Add and send invitation"
                    : "Add open position"
            }
            onPress={submit}
          />
          <AppButton
            variant="secondary"
            disabled={!active || work.locked}
            label="Discard draft"
            onPress={() => setConfirm("discard")}
          />
        </>
      ) : null}
      {confirm ? (
        <View style={styles.responseBox}>
          <Text style={styles.responseValue}>
            {confirm === "discard"
              ? "Discard this draft?"
              : removing
                ? "Remove this position?"
                : "Replace confirmed crew member?"}
          </Text>
          <Text style={styles.assignmentCopy}>
            {confirm === "discard"
              ? "Your unsaved changes will be discarded. The shared schedule will stay as it is."
              : removing
                ? `${fields.role} will be removed from ${draft.showName} on ${fields.serviceDate}. Its pending invitation will close.`
                : fields.crewMemberId
                  ? "Their confirmation will be cleared and the new person will receive a fresh invitation."
                  : "Their confirmation will be cleared and the position will become unassigned."}
          </Text>
          <AppButton
            variant="danger"
            disabled={!active || work.locked}
            label={
              confirm === "discard"
                ? "Confirm discard"
                : removing
                  ? "Remove position"
                  : fields.crewMemberId
                    ? "Replace and invite"
                    : "Make position open"
            }
            onPress={() => {
              if (!active || !confirm) return;
              if (confirm === "discard") {
                if (work.discard()) onClose();
              } else {
                work.submit();
                setConfirm(null);
              }
            }}
          />
          <AppButton
            variant="secondary"
            label="Cancel"
            onPress={() => setConfirm(null)}
          />
        </View>
      ) : null}
      {attempt ? (
        <View accessibilityLiveRegion="polite" style={styles.responseBox}>
          {attempt.kind === "pending" ? (
            <Text style={styles.assignmentCopy}>
              Checking assignment save… You can close this editor and return to
              check the result.
            </Text>
          ) : null}
          {attempt.kind === "failed" ? (
            <>
              <Text accessibilityRole="alert" style={styles.assignmentCopy}>
                {attempt.message}
              </Text>
              <Text style={styles.assignmentCopy}>
                The original save may already have applied. Retry checks that
                same save and invitation.
              </Text>
              <AppButton
                disabled={!active}
                label="Retry original save"
                onPress={work.retry}
              />
              <Text style={styles.assignmentCopy}>
                Review checks the original save. If it has not applied, review
                cancels it before you edit. If it has applied, review checks
                that same invitation.
              </Text>
              <AppButton
                disabled={!active}
                variant="secondary"
                label="Review original request"
                onPress={work.reviewOriginal}
              />
            </>
          ) : null}
          {result ? (
            <>
              {attempt.kind !== "confirmed" ? (
                <Text style={styles.assignmentCopy}>
                  Previous confirmed result:
                </Text>
              ) : null}
              <Text style={styles.responseValue}>
                {result.outcome === "applied"
                  ? removing
                    ? "Position removed."
                    : replacingDecline
                      ? "Replacement position saved. The original declined response is retained."
                      : "Assignment saved."
                  : result.outcome === "conflict"
                    ? "This request was not applied. Review current details before saving again."
                    : "This position changed after the original save. Your original request will not overwrite it."}
              </Text>
              {result.invitation ? (
                <Text style={styles.assignmentCopy}>
                  {reminderMessage(result.invitation, "invitation")}
                </Text>
              ) : null}
            </>
          ) : null}
          {attempt.kind === "confirmed" ? (
            <>
              {attempt.refresh === "pending" ? (
                <Text style={styles.assignmentCopy}>
                  Save checked. Refreshing Schedule…
                </Text>
              ) : null}
              {attempt.refresh === "idle" || attempt.refresh === "failed" ? (
                <>
                  {attempt.message ? (
                    <Text
                      accessibilityRole="alert"
                      style={styles.assignmentCopy}
                    >
                      {attempt.message}
                    </Text>
                  ) : null}
                  <Text style={styles.assignmentCopy}>
                    The result is retained. Refreshing does not save or send
                    invitations again.
                  </Text>
                  <AppButton
                    disabled={!active}
                    label="Refresh Schedule"
                    onPress={work.refresh}
                  />
                </>
              ) : null}
              {settled ? (
                assignmentRetryable(attempt.result) ? (
                  <AppButton
                    disabled={!active}
                    label="Retry original save"
                    onPress={work.retry}
                  />
                ) : (
                  <>
                    {draft.mode === "create" &&
                    attempt.result.outcome === "conflict" ? (
                      <AppButton
                        disabled={!active}
                        label="Edit original draft"
                        onPress={work.editUnapplied}
                      />
                    ) : null}
                    {draft.mode !== "create" &&
                    attempt.result.outcome !== "applied" ? (
                      <>
                        <Text style={styles.assignmentCopy}>
                          Loading current details replaces the fields above.
                          Review them before trying again.
                        </Text>
                        <AppButton
                          disabled={!active || work.reading}
                          label="Load current position"
                          onPress={work.loadCurrent}
                        />
                      </>
                    ) : null}
                    <AppButton
                      disabled={!active || work.reading}
                      label="Finish and close"
                      onPress={() => {
                        if (work.finish()) onClose();
                      }}
                    />
                  </>
                )
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}
    </ScheduleSheet>
  );
}

export function ScheduleTeamSheet({
  orgId,
  userId,
  active,
  initial,
  crew,
  onClose,
  onCommand,
  onRefresh,
}: {
  orgId: string;
  userId: string;
  active: boolean;
  initial: TeamDraft;
  crew: Crew[];
  onClose: () => void;
  onCommand: (
    command: ScheduleAssignmentCommand,
    review: boolean,
    signal: AbortSignal,
  ) => Promise<ScheduleAssignmentResult>;
  onRefresh: (signal: AbortSignal) => Promise<void>;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const work = useMobileTeam({ orgId, userId }, initial, {
    active,
    send: onCommand,
    refresh: onRefresh,
  });
  const { draft, attempt } = work;
  const [search, setSearch] = useState("");
  const [confirmation, setConfirmation] = useState<"send" | "discard" | null>(
    null,
  );
  useEffect(() => {
    setConfirmation(null);
  }, [active, orgId, userId, initial.showId]);
  const locked = !active || !!attempt || !!confirmation;
  const visible = crew
    .filter(
      (person) =>
        person.email &&
        !draft.rows.some((row) => row.crewMemberId === person.id) &&
        (!search.trim() ||
          `${person.name} ${person.role}`
            .toLowerCase()
            .includes(search.trim().toLowerCase())),
    )
    .slice(0, 50);
  const missing = draft.rows.some(
    (row) =>
      !crew.some((person) => person.id === row.crewMemberId && person.email),
  );
  const valid =
    !!draft.department.trim() &&
    draft.rows.length > 0 &&
    draft.rows.length <= 50 &&
    draft.rows.every((row) => row.role.trim()) &&
    !missing;
  const result =
    attempt?.kind === "confirmed" ? attempt.result : attempt?.previous;
  return (
    <ScheduleSheet
      eyebrow="TEAM BUILDER"
      onClose={onClose}
      title="Build a team"
    >
      <Text style={styles.intro}>
        {draft.showName} · {draft.serviceDate} · {draft.timeZone}
      </Text>
      <Text style={styles.assignmentCopy}>
        Choose people and review their roles before sending invitations. Closing
        retains this team and its save results. Signing out or restarting the
        app clears local drafts.
      </Text>
      <AppField
        editable={!locked}
        autoCapitalize="words"
        label="Team or department"
        maxLength={80}
        onChangeText={(department) => {
          if (!locked) work.setDraft((value) => ({ ...value, department }));
        }}
        placeholder="Broadcast"
        value={draft.department}
      />
      {draft.rows.map((row) => (
        <View
          key={row.crewMemberId}
          style={[styles.teamPerson, styles.choiceActive]}
        >
          <Text style={styles.choiceName}>{row.name}</Text>
          <Text style={styles.assignmentCopy}>{row.email}</Text>
          {!crew.some(
            (person) => person.id === row.crewMemberId && person.email,
          ) ? (
            <Text style={styles.assignmentCopy}>
              This roster contact is unavailable. The selection is retained;
              remove it or refresh the roster before a new save.
            </Text>
          ) : null}
          <AppField
            editable={!locked}
            autoCapitalize="words"
            label={`Role for ${row.name}`}
            maxLength={120}
            value={row.role}
            onChangeText={(role) => {
              if (!locked)
                work.setDraft((value) => ({
                  ...value,
                  rows: value.rows.map((person) =>
                    person.crewMemberId === row.crewMemberId
                      ? { ...person, role }
                      : person,
                  ),
                }));
            }}
          />
          {!attempt ? (
            <AppButton
              variant="secondary"
              disabled={locked}
              label={`Remove ${row.name} from selection`}
              onPress={() =>
                work.setDraft((value) => ({
                  ...value,
                  rows: value.rows.filter(
                    (person) => person.crewMemberId !== row.crewMemberId,
                  ),
                }))
              }
            />
          ) : null}
        </View>
      ))}
      {!attempt ? (
        <>
          <View style={styles.search}>
            <Search color={colors.textFaint} size={15} />
            <TextInput
              editable={!locked}
              accessibilityLabel="Search roster for team"
              onChangeText={setSearch}
              placeholder="Search available roster"
              placeholderTextColor={colors.textFaint}
              style={styles.searchInput}
              value={search}
            />
          </View>
          {visible.map((person) => (
            <Pressable
              key={person.id}
              accessibilityRole="checkbox"
              accessibilityState={{
                checked: false,
                disabled: locked || draft.rows.length >= 50,
              }}
              disabled={locked || draft.rows.length >= 50}
              onPress={() => {
                if (!locked)
                  work.setDraft((value) =>
                    value.rows.length >= 50 ||
                    value.rows.some((row) => row.crewMemberId === person.id)
                      ? value
                      : {
                          ...value,
                          rows: [
                            ...value.rows,
                            {
                              crewMemberId: person.id,
                              name: person.name,
                              email: person.email!,
                              role: person.role || "Crew",
                            },
                          ],
                        },
                  );
              }}
              style={styles.choice}
            >
              <View style={styles.checkbox} />
              <View style={styles.choiceCopy}>
                <Text style={styles.choiceName}>{person.name}</Text>
                <Text style={styles.choiceMeta}>{person.email}</Text>
              </View>
            </Pressable>
          ))}
          {draft.rows.length === 50 ? (
            <Text style={styles.assignmentCopy}>
              50 people selected. Finish this team before creating another.
            </Text>
          ) : null}
          {!visible.length ? (
            <Text style={styles.assignmentCopy}>
              No more matching roster contacts with email addresses.
            </Text>
          ) : null}
        </>
      ) : null}
      {work.error ? (
        <Text accessibilityRole="alert" style={styles.assignmentCopy}>
          {work.error}
        </Text>
      ) : null}
      {!attempt && !confirmation ? (
        <>
          <AppButton
            disabled={!active || !valid}
            label={`Create team and send ${draft.rows.length} invitation${draft.rows.length === 1 ? "" : "s"}`}
            onPress={() => {
              if (active && valid) setConfirmation("send");
            }}
          />
          <AppButton
            variant="secondary"
            disabled={!active}
            label="Discard team draft"
            onPress={() => setConfirmation("discard")}
          />
        </>
      ) : null}
      {confirmation ? (
        <View style={styles.responseBox}>
          <Text style={styles.responseValue}>
            {confirmation === "send"
              ? "Create these positions and send invitations?"
              : "Discard this team draft?"}
          </Text>
          <Text style={styles.assignmentCopy}>
            {confirmation === "send"
              ? `${draft.rows.length} people · ${draft.department} · ${draft.showName} · ${draft.serviceDate}`
              : "Unsaved selections and roles will be discarded. The shared schedule will stay as it is."}
          </Text>
          {confirmation === "send"
            ? draft.rows.map((row) => (
                <Text key={row.crewMemberId} style={styles.assignmentCopy}>
                  {row.name} · {row.role}
                </Text>
              ))
            : null}
          <AppButton
            disabled={!active || (confirmation === "send" && !valid)}
            label={
              confirmation === "send"
                ? "Create reviewed team"
                : "Confirm discard team"
            }
            onPress={() => {
              if (!active) return;
              if (confirmation === "discard") {
                if (work.discard()) onClose();
              } else if (valid) {
                work.submit();
                setConfirmation(null);
              }
            }}
          />
          <AppButton
            variant="secondary"
            label="Cancel team creation"
            onPress={() => setConfirmation(null)}
          />
        </View>
      ) : null}
      {attempt ? (
        <View accessibilityLiveRegion="polite" style={styles.responseBox}>
          {attempt.kind === "pending" ? (
            <Text style={styles.assignmentCopy}>
              Checking each position and invitation… You can close this sheet
              and return to check the results.
            </Text>
          ) : null}
          {attempt.kind === "failed" ? (
            <>
              <Text accessibilityRole="alert" style={styles.assignmentCopy}>
                {attempt.message}
              </Text>
              <Text style={styles.assignmentCopy}>
                Some positions may already exist. Retry checks the original
                selection and saves.
              </Text>
              <AppButton
                disabled={!active}
                label="Retry unresolved team positions"
                onPress={work.retry}
              />
            </>
          ) : null}
          {result ? (
            <>
              {attempt.kind !== "confirmed" ? (
                <Text style={styles.assignmentCopy}>
                  Previous confirmed results:
                </Text>
              ) : null}
              {result.rows.map((row) => (
                <View key={row.requestId} style={styles.teamPerson}>
                  <Text style={styles.choiceName}>{row.name}</Text>
                  <Text style={styles.assignmentCopy}>
                    {!row.result
                      ? "Position save is unconfirmed."
                      : row.result.outcome === "applied"
                        ? "Position saved."
                        : row.result.outcome === "conflict"
                          ? "This request was not applied."
                          : "This position changed after the original save; it will not be overwritten or recreated."}
                  </Text>
                  {row.result?.invitation ? (
                    <Text style={styles.assignmentCopy}>
                      {reminderMessage(row.result.invitation, "invitation")}
                    </Text>
                  ) : null}
                  {row.error ? (
                    <Text
                      accessibilityRole="alert"
                      style={styles.assignmentCopy}
                    >
                      {row.error}
                    </Text>
                  ) : null}
                </View>
              ))}
            </>
          ) : null}
          {attempt.kind === "confirmed" ? (
            <>
              {attempt.refresh === "pending" ? (
                <Text style={styles.assignmentCopy}>
                  Results retained. Refreshing Schedule…
                </Text>
              ) : null}
              {attempt.refresh === "idle" || attempt.refresh === "failed" ? (
                <>
                  {attempt.message ? (
                    <Text
                      accessibilityRole="alert"
                      style={styles.assignmentCopy}
                    >
                      {attempt.message}
                    </Text>
                  ) : null}
                  <Text style={styles.assignmentCopy}>
                    Refresh reloads the schedule without creating positions or
                    sending invitations again.
                  </Text>
                  <AppButton
                    disabled={!active}
                    label="Refresh team schedule"
                    onPress={work.refresh}
                  />
                </>
              ) : null}
              {attempt.refresh === "done" ? (
                teamRetryable(attempt.result) ? (
                  <AppButton
                    disabled={!active}
                    label="Retry unresolved team positions"
                    onPress={work.retry}
                  />
                ) : (
                  <>
                    {attempt.result.rows.some(
                      (row) => row.result?.outcome === "conflict",
                    ) ? (
                      <>
                        <Text style={styles.assignmentCopy}>
                          Only unapplied positions remain when you edit. Saved
                          positions stay on the schedule.
                        </Text>
                        <AppButton
                          disabled={!active}
                          label="Edit unapplied positions"
                          onPress={work.editUnapplied}
                        />
                      </>
                    ) : null}
                    <AppButton
                      disabled={!active}
                      label="Finish team and close"
                      onPress={() => {
                        if (work.finish()) onClose();
                      }}
                    />
                  </>
                )
              ) : null}
            </>
          ) : null}
          {attempt.kind === "failed" ||
          (attempt.kind === "confirmed" &&
            attempt.refresh === "done" &&
            teamRetryable(attempt.result)) ? (
            <>
              <Text style={styles.assignmentCopy}>
                Review cancels any unapplied requests before you edit.
                Already-saved positions remain; review may retry their original
                unresolved invitations.
              </Text>
              <AppButton
                variant="secondary"
                disabled={!active}
                label="Review original team requests"
                onPress={work.review}
              />
            </>
          ) : null}
        </View>
      ) : null}
    </ScheduleSheet>
  );
}

export function ScheduleInventorySheet({
  orgId,
  userId,
  active,
  archivedInventory,
  canManage,
  inventory,
  onCommand,
  onRefresh,
  onClose,
  onUse,
  savedTemplates,
}: {
  orgId: string;
  userId: string;
  active: boolean;
  onCommand: (
    command: InventoryCommand,
    review: boolean,
    signal: AbortSignal,
  ) => Promise<InventoryResult>;
  onRefresh: (signal: AbortSignal) => Promise<void>;
  archivedInventory: MobileSchedule["archivedInventory"];
  canManage: boolean;
  inventory: MobileSchedule["inventory"];
  onClose: () => void;
  onUse: (inventoryId: string) => void;
  savedTemplates: MobileSchedule["savedTemplates"];
}) {
  const workspaceTerms = useWorkspaceTerms();
  const styles = useStyles();
  const work = useMobileInventory(
    { orgId, userId },
    onRefresh,
    onCommand,
    active,
  );
  const { name, description, location, defaultStartTime, sourceTemplateId } =
    work.draft;
  const missingSource =
    !!sourceTemplateId &&
    !savedTemplates.some((source) => source.id === sourceTemplateId);
  const valid =
    name.trim().length > 0 &&
    (!defaultStartTime || /^([01]\d|2[0-3]):[0-5]\d$/.test(defaultStartTime)) &&
    !missingSource;
  function change<K extends keyof InventoryDraft>(
    field: K,
    value: InventoryDraft[K],
  ) {
    work.setDraft((draft) => ({ ...draft, [field]: value }));
  }
  const setName = (value: string) => change("name", value);
  const setDescription = (value: string) => change("description", value);
  const setLocation = (value: string) => change("location", value);
  const setDefaultStartTime = (value: string) =>
    change("defaultStartTime", value);
  const setSourceTemplateId = (value: string | null) =>
    change("sourceTemplateId", value);
  const attempt = work.attempt;
  const archive = (item: MobileSchedule["inventory"][number]) =>
    Alert.alert(
      "Archive reusable show?",
      `Archive “${item.name}” from inventory? Scheduled shows are unchanged. You can restore this definition from Archived.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Archive",
          style: "destructive",
          onPress: () => work.archive(item, true),
        },
      ],
    );
  return (
    <ScheduleSheet
      eyebrow="REUSABLE SHOWS"
      onClose={onClose}
      title="Show inventory"
    >
      <Text style={styles.intro}>
        Save a clean show structure once, then load that snapshot into any
        future date. Scheduled changes never rewrite the inventory.
      </Text>
      {work.notice ? (
        <Text accessibilityRole="alert" style={styles.intro}>
          {work.notice}
        </Text>
      ) : null}
      {attempt ? (
        <View style={styles.inventorySection} accessibilityLiveRegion="polite">
          <Text style={styles.choiceName}>{attempt.label}</Text>
          {attempt.kind === "saving" || attempt.kind === "reviewing" ? (
            <Text style={styles.intro}>
              {attempt.kind === "saving"
                ? "Saving…"
                : "Reviewing original request…"}{" "}
              You can close this sheet and return to check the result.
            </Text>
          ) : null}
          {attempt.kind === "unconfirmed" ? (
            <>
              <Text accessibilityRole="alert" style={styles.intro}>
                {attempt.message}
              </Text>
              <Text style={styles.intro}>
                The result is unconfirmed. Retry the same request, or review it
                before editing. Review cancels a request that has not reached
                the server.
              </Text>
              <AppButton label="Retry change" onPress={work.retry} />
              <AppButton
                label="Review original request"
                onPress={work.review}
              />
            </>
          ) : null}
          {attempt.kind === "settled" ? (
            <>
              <Text style={styles.intro}>
                {attempt.result.outcome === "applied"
                  ? "Change confirmed. Refresh inventory to see the latest list."
                  : attempt.result.outcome === "superseded"
                    ? "The original change succeeded. Later changes are preserved."
                    : attempt.result.outcome === "removed"
                      ? "This item was removed. Retrying this request will not recreate it."
                      : "The item or its source changed. Refresh and review the current details before trying again."}
              </Text>
              {attempt.result.item ? (
                <Text style={styles.intro}>
                  Current item: {attempt.result.item.name} ·{" "}
                  {attempt.result.item.archivedAt ? "Archived" : "Active"}
                </Text>
              ) : null}
              {attempt.message ? (
                <Text accessibilityRole="alert" style={styles.intro}>
                  {attempt.message}
                </Text>
              ) : null}
              <AppButton
                label={
                  attempt.refresh === "pending"
                    ? "Refreshing inventory…"
                    : "Refresh inventory"
                }
                disabled={attempt.refresh === "pending"}
                onPress={work.refresh}
              />
            </>
          ) : null}
        </View>
      ) : null}
      <View style={styles.inventorySection}>
        <Text style={styles.fieldLabel}>AVAILABLE</Text>
        {inventory.length ? (
          inventory.map((item) => (
            <View key={item.id} style={styles.inventoryRow}>
              <View style={[styles.choiceCopy, styles.inventoryCopy]}>
                <Text style={styles.choiceName}>{item.name}</Text>
                <Text style={styles.choiceMeta}>
                  {item.itemCount} rundown item{item.itemCount === 1 ? "" : "s"}
                  {item.defaultStartTime ? ` · ${item.defaultStartTime}` : ""}
                  {item.location ? ` · ${item.location}` : ""}
                </Text>
                {item.description ? (
                  <Text style={styles.hint}>{item.description}</Text>
                ) : null}
              </View>
              {canManage ? (
                <View style={styles.inventoryActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Use ${item.name}`}
                    disabled={
                      !!attempt &&
                      attempt.command.operation.kind === "archive" &&
                      attempt.command.operation.id === item.id
                    }
                    onPress={() => onUse(item.id)}
                    style={styles.miniButton}
                  >
                    <Text style={styles.miniButtonPrimary}>Use</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Archive ${item.name}`}
                    disabled={work.locked}
                    onPress={() => archive(item)}
                    style={[styles.miniButton, work.locked && styles.choiceDisabled]}
                  >
                    <Text style={styles.miniButtonDanger}>Archive</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ))
        ) : (
          <Text style={styles.emptyInventory}>No reusable shows yet.</Text>
        )}
      </View>
      {archivedInventory.length ? (
        <View style={styles.inventorySection}>
          <Text style={styles.fieldLabel}>ARCHIVED</Text>
          {archivedInventory.map((item) => (
            <View key={item.id} style={styles.inventoryRow}>
              <View style={[styles.choiceCopy, styles.inventoryCopy]}>
                <Text style={styles.choiceName}>{item.name}</Text>
                <Text style={styles.choiceMeta}>
                  {item.itemCount} rundown items
                </Text>
              </View>
              {canManage ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Restore ${item.name}`}
                  disabled={work.locked}
                  onPress={() => work.archive(item, false)}
                  style={[styles.miniButton, work.locked && styles.choiceDisabled]}
                >
                  <Text style={styles.miniButtonPrimary}>Restore</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      {canManage ? (
        <View style={styles.inventoryForm}>
          <Text style={styles.fieldLabel}>ADD REUSABLE SHOW</Text>
          <AppField
            editable={!work.locked}
            autoCapitalize="words"
            label="Show name"
            maxLength={120}
            onChangeText={setName}
            placeholder={workspaceCopy("Sunday Morning", workspaceTerms)}
            value={name}
          />
          <AppField
            editable={!work.locked}
            autoCapitalize="none"
            error={
              defaultStartTime &&
              !/^([01]\d|2[0-3]):[0-5]\d$/.test(defaultStartTime)
                ? "Use 24-hour HH:mm."
                : undefined
            }
            keyboardType="numbers-and-punctuation"
            label="Default start (optional)"
            maxLength={5}
            onChangeText={setDefaultStartTime}
            placeholder="10:00"
            value={defaultStartTime}
          />
          <AppField
            editable={!work.locked}
            autoCapitalize="words"
            label="Location (optional)"
            maxLength={240}
            onChangeText={setLocation}
            placeholder="Main room"
            value={location}
          />
          {savedTemplates.length || missingSource ? (
            <View style={styles.picker}>
              <Text style={styles.fieldLabel}>RUNDOWN SOURCE</Text>
              {missingSource ? (
                <Text accessibilityRole="alert" style={styles.intro}>
                  The selected saved rundown is unavailable. Choose another
                  source or explicitly choose an empty rundown.
                </Text>
              ) : null}
              <Pressable
                disabled={work.locked}
                accessibilityRole="radio"
                accessibilityState={{ checked: sourceTemplateId === null }}
                onPress={() => setSourceTemplateId(null)}
                style={[
                  styles.choice,
                  sourceTemplateId === null && styles.choiceActive,
                ]}
              >
                <View style={[styles.choiceCopy, styles.inventoryCopy]}>
                  <Text style={styles.choiceName}>Empty rundown</Text>
                  <Text style={styles.choiceMeta}>
                    Add items after scheduling
                  </Text>
                </View>
              </Pressable>
              {savedTemplates.map((template) => (
                <Pressable
                  disabled={work.locked}
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked: sourceTemplateId === template.id,
                  }}
                  key={template.id}
                  onPress={() => setSourceTemplateId(template.id)}
                  style={[
                    styles.choice,
                    sourceTemplateId === template.id && styles.choiceActive,
                  ]}
                >
                  <View style={[styles.choiceCopy, styles.inventoryCopy]}>
                    <Text style={styles.choiceName}>{template.name}</Text>
                    <Text style={styles.choiceMeta}>
                      {template.itemCount} saved item
                      {template.itemCount === 1 ? "" : "s"}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null}
          <AppField
            editable={!work.locked}
            autoCapitalize="sentences"
            label="Description (optional)"
            maxLength={500}
            multiline
            onChangeText={setDescription}
            placeholder="When this reusable show should be used"
            style={styles.notes}
            textAlignVertical="top"
            value={description}
          />
          <AppButton
            disabled={!valid || work.locked}
            label="Add to inventory"
            onPress={work.create}
          />
        </View>
      ) : null}
    </ScheduleSheet>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  headerCopy: { flex: 1, gap: 4 },
  eyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.2 },
  title: { color: colors.text, fontFamily, fontSize: 21, fontWeight: "900" },
  assignmentCopy: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20 },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 13, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  content: { gap: spacing.medium, paddingBottom: 40 },
  intro: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 19 },
  picker: { gap: 7 },
  fieldLabel: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  search: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 12 },
  searchInput: { flex: 1, color: colors.text, fontFamily, fontSize: 13 },
  choice: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: 11 },
  choiceActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  choiceDisabled: { opacity: 0.45 },
  choiceCopy: { flex: 1, minWidth: 0, gap: 3 },
  choiceName: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "800" },
  choiceMeta: { color: colors.textMuted, fontFamily, fontSize: 11 },
  hint: { color: colors.textFaint, fontFamily, fontSize: 11, lineHeight: 16 },
  notes: { minHeight: 92, paddingTop: 13 },
  responseBox: { gap: 5, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 12 },
  responseLabel: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 0.8 },
  responseValue: { color: colors.amberText, fontFamily, fontSize: 12, fontWeight: "800", textTransform: "capitalize" },
  responseNote: { color: colors.text, fontFamily, fontSize: 11, lineHeight: 17 },
  teamPerson: { gap: 9, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: 10 },
  teamToggle: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 10 },
  checkbox: { width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: colors.border },
  checkboxActive: { borderColor: colors.amber, backgroundColor: colors.amber },
  inventorySection: { gap: 8 },
  inventoryCopy: { flex: 0, width: "100%" },
  inventoryRow: { minHeight: 62, flexDirection: "column", alignItems: "stretch", gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: 11 },
  inventoryActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 5 },
  miniButton: { minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10 },
  miniButtonPrimary: { color: colors.amberText, fontFamily, fontSize: 13, fontWeight: "900" },
  miniButtonDanger: { color: colors.red, fontFamily, fontSize: 13, fontWeight: "900" },
  emptyInventory: { color: colors.textFaint, fontFamily, fontSize: 11, textAlign: "center", borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: 18 },
  inventoryForm: { gap: spacing.medium, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.medium },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  option: { minHeight: 42, justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 13 },
  optionActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  optionText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800" },
  optionTextActive: { color: colors.amberText },
}));

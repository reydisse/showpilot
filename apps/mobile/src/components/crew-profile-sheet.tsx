import { useEffect, useRef, useState } from "react";
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import X from "lucide-react-native/icons/x";
import UserRound from "lucide-react-native/icons/user-round";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { Page } from "@/components/page";
import { useScreenFocus } from "@/hooks/use-screen-polling";
import { useCrewProfile } from "@/hooks/use-crew-profile";
import {
  crewRoles,
  crewFieldsSchema,
  prepareCrewPhoto,
  type CrewDraft,
} from "@/lib/crew-recovery";
import {
  executeMobileCrewCommand,
  readMobileCrewProfile,
  resolveMobileAvatarUrl,
} from "@/lib/mobile-api";
import {
  createThemedStyles,
  fontFamily,
  spacing,
  useAppTheme,
} from "@/theme/tokens";
export function crewPhotoUri(value: string): string | null {
  if (
    /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+=*$/i.test(value)
  )
    return value;
  return resolveMobileAvatarUrl(value);
}
export function CrewProfileSheet(props: {
  orgId: string;
  userId: string;
  initial: CrewDraft;
  onClose: () => void;
}) {
  const styles = useStyles(),
    { colors } = useAppTheme(),
    client = useQueryClient(),
    active = useScreenFocus();
  const [confirmation, setConfirmation] = useState<
    "delete" | "discard" | "load" | null
  >(null);
  const [photoError, setPhotoError] = useState<string>(),
    [preparingPhoto, setPreparingPhoto] = useState(false),
    photoAttempt = useRef(0);
  useEffect(() => {
    const generation = photoAttempt;
    if (!active) {
      setConfirmation(null);
      generation.current++;
      setPreparingPhoto(false);
    }
    return () => {
      generation.current++;
    };
  }, [active]);
  const state = useCrewProfile(
    { orgId: props.orgId, userId: props.userId },
    props.initial,
    {
      active,
      send: executeMobileCrewCommand,
      read: readMobileCrewProfile,
      refresh: async (signal) => {
        await Promise.all([
          client.invalidateQueries(
            { queryKey: ["mobile-team-crew", props.userId, props.orgId] },
            { throwOnError: true },
          ),
          client.invalidateQueries(
            { queryKey: ["mobile-checkin"] },
            { throwOnError: true },
          ),
          client.invalidateQueries(
            { queryKey: ["mobile-schedule", props.orgId] },
            { throwOnError: true },
          ),
        ]);
        if (signal.aborted) throw new Error("Crew refresh cancelled.");
      },
    },
  );
  const { draft, attempt } = state;
  const [customRole, setCustomRole] = useState(
    !crewRoles.includes(draft.fields.role),
  );
  const editable = active && !state.locked && !confirmation && !preparingPhoto;
  const deleting = draft.kind === "delete";
  const settled = attempt?.kind === "confirmed" && attempt.refresh === "done";
  const applied =
    attempt?.kind === "confirmed" && attempt.result.outcome === "applied";
  const photo = crewPhotoUri(draft.fields.photoUrl);
  function finish() {
    if (state.discard()) props.onClose();
  }
  async function choosePhoto() {
    if (!editable) return;
    const attempt = ++photoAttempt.current;
    setPhotoError(undefined);
    try {
      const selection = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 1,
      });
      if (selection.canceled || attempt !== photoAttempt.current) return;
      setPreparingPhoto(true);
      const photoUrl = await prepareCrewPhoto(async () => {
        const processed = await ImageManipulator.manipulateAsync(
          selection.assets[0].uri,
          [{ resize: { width: 480, height: 480 } }],
          { compress: 0.76, format: ImageManipulator.SaveFormat.JPEG },
        );
        return `data:image/jpeg;base64,${await new File(processed.uri).base64()}`;
      });
      if (attempt === photoAttempt.current) state.setFields({ photoUrl });
    } catch (error) {
      if (attempt === photoAttempt.current)
        setPhotoError(
          error instanceof Error ? error.message : "Choose another photo.",
        );
    } finally {
      if (attempt === photoAttempt.current) setPreparingPhoto(false);
    }
  }
  const title = deleting
    ? "Remove crew member"
    : draft.kind === "create"
      ? "Add crew member"
      : "Edit crew member";
  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onClose}
      presentationStyle="pageSheet"
      visible
    >
      <Page scroll={false}>
        <View style={styles.header}>
          <View style={styles.copy}>
            <Text style={styles.eyebrow}>CREW ROSTER</Text>
            <Text style={styles.title}>{title}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close crew member form"
            onPress={props.onClose}
            style={styles.close}
          >
            <X color={colors.textMuted} size={21} />
          </Pressable>
        </View>
        <ScrollView
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.hint}>
            Closing keeps this draft and its original request while you remain
            signed in.
          </Text>
          {state.error || photoError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {state.error || photoError}
            </Text>
          ) : null}
          {state.reading ? (
            <Text accessibilityLiveRegion="polite" style={styles.hint}>
              Loading the current crew profile…
            </Text>
          ) : null}
          {deleting ? (
            <Text style={styles.hint}>
              Remove {draft.fields.name} ({draft.fields.memberId}) from the
              production roster? Existing schedule positions will become
              unassigned.
            </Text>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Choose crew photo"
                disabled={!editable}
                onPress={() => void choosePhoto()}
                style={styles.photo}
              >
                {photo ? (
                  <Image source={{ uri: photo }} style={styles.photoImage} />
                ) : (
                  <UserRound color={colors.amberText} size={34} />
                )}
              </Pressable>
              <Text style={styles.hint}>
                {preparingPhoto
                  ? "Preparing photo…"
                  : "Choose a square crew photo."}
              </Text>
              <AppField
                label="Crew member ID"
                autoCapitalize="characters"
                maxLength={128}
                editable={editable}
                value={draft.fields.memberId}
                onChangeText={(memberId) =>
                  state.setFields({ memberId: memberId.toUpperCase() })
                }
              />
              <Text style={styles.hint}>
                Used for badge scanning and quick check-in.
              </Text>
              <AppField
                label="Crew member name"
                autoCapitalize="words"
                maxLength={200}
                editable={editable}
                value={draft.fields.name}
                onChangeText={(name) => state.setFields({ name })}
              />
              <AppField
                label="Crew member email"
                autoComplete="email"
                inputMode="email"
                maxLength={254}
                editable={editable}
                value={draft.fields.email}
                onChangeText={(email) => state.setFields({ email })}
              />
              <Text style={styles.hint}>
                Email is optional and receives schedule requests and reminders.
              </Text>
              <Text style={styles.label}>ROLE</Text>
              <View style={styles.roles}>
                {crewRoles.map((role) => (
                  <Pressable
                    key={role}
                    accessibilityRole="radio"
                    accessibilityLabel={role}
                    accessibilityState={{
                      checked: draft.fields.role === role && !customRole,
                      disabled: !editable,
                    }}
                    disabled={!editable}
                    onPress={() => {
                      state.setFields({ role });
                      setCustomRole(false);
                    }}
                    style={[
                      styles.role,
                      draft.fields.role === role &&
                        !customRole &&
                        styles.selected,
                    ]}
                  >
                    <Text style={styles.label}>{role}</Text>
                  </Pressable>
                ))}
                <Pressable
                  accessibilityRole="radio"
                  accessibilityLabel="Custom role"
                  accessibilityState={{
                    checked: customRole,
                    disabled: !editable,
                  }}
                  disabled={!editable}
                  onPress={() => {
                    setCustomRole(true);
                    if (crewRoles.includes(draft.fields.role))
                      state.setFields({ role: "" });
                  }}
                  style={[styles.role, customRole && styles.selected]}
                >
                  <Text style={styles.label}>Custom role</Text>
                </Pressable>
              </View>
              {customRole || !crewRoles.includes(draft.fields.role) ? (
                <AppField
                  label="Custom crew role"
                  maxLength={100}
                  editable={editable}
                  value={draft.fields.role}
                  onChangeText={(role) => state.setFields({ role })}
                />
              ) : null}
            </>
          )}
          {!attempt ? (
            <AppButton
              label={
                deleting
                  ? "Remove crew member…"
                  : draft.kind === "create"
                    ? "Add crew member"
                    : "Update crew member"
              }
              variant={deleting ? "danger" : "primary"}
              disabled={
                !editable ||
                (!deleting && !crewFieldsSchema.safeParse(draft.fields).success)
              }
              onPress={() =>
                deleting ? setConfirmation("delete") : state.submit()
              }
            />
          ) : null}
          {attempt?.kind === "pending" ? (
            <Text accessibilityLiveRegion="polite" style={styles.hint}>
              Confirming the original crew change…
            </Text>
          ) : null}
          {attempt?.kind === "failed" ? (
            <>
              <Text accessibilityRole="alert" style={styles.error}>
                {attempt.message} The change may already have saved. Retry sends
                the same request; Review checks it or cancels it before a late
                write can apply.
              </Text>
              <AppButton
                label="Retry original crew change"
                disabled={!active}
                onPress={state.retry}
              />
              <AppButton
                label="Review original crew change"
                variant="secondary"
                disabled={!active}
                onPress={state.review}
              />
            </>
          ) : null}
          {attempt?.kind === "confirmed" ? (
            <>
              <Text accessibilityLiveRegion="polite" style={styles.hint}>
                {applied
                  ? "The original crew change was saved."
                  : "The original crew change was cancelled before it applied. Your draft is retained."}
              </Text>
              {attempt.refresh === "pending" ? (
                <Text style={styles.hint}>Refreshing the roster…</Text>
              ) : null}
              {attempt.refresh === "failed" || attempt.refresh === "idle" ? (
                <>
                  <Text accessibilityRole="alert" style={styles.error}>
                    {attempt.message ?? "Refresh the roster to finish."} The
                    outcome above is confirmed.
                  </Text>
                  <AppButton
                    label="Refresh roster only"
                    disabled={!active}
                    onPress={state.refresh}
                  />
                </>
              ) : null}
              {settled ? (
                applied ? (
                  <AppButton
                    label="Finish crew change"
                    disabled={!active || !!confirmation}
                    onPress={finish}
                  />
                ) : (
                  <AppButton
                    label="Edit cancelled crew change"
                    disabled={!active || !!confirmation}
                    onPress={state.editCancelled}
                  />
                )
              ) : null}
            </>
          ) : null}
          {active &&
          !state.reading &&
          !preparingPhoto &&
          (!attempt || settled) ? (
            <>
              {draft.base && !(deleting && applied) ? (
                <AppButton
                  label="Load current crew profile…"
                  variant="secondary"
                  disabled={!!confirmation}
                  onPress={() => setConfirmation("load")}
                />
              ) : null}
              {!applied ? (
                <AppButton
                  label="Discard crew draft…"
                  variant="secondary"
                  disabled={!!confirmation}
                  onPress={() => setConfirmation("discard")}
                />
              ) : null}
            </>
          ) : null}
          {confirmation ? (
            <View style={styles.confirmation}>
              <Text style={styles.hint}>
                {confirmation === "delete"
                  ? `Remove ${draft.fields.name} (${draft.fields.memberId})? Its schedule positions will become unassigned.`
                  : confirmation === "load"
                    ? "Replace this retained draft with the current crew profile? No change will be saved."
                    : "Discard this retained crew draft? This does not undo any saved change."}
              </Text>
              <AppButton
                label={
                  confirmation === "delete"
                    ? "Remove crew member"
                    : confirmation === "load"
                      ? "Replace with current profile"
                      : "Discard draft"
                }
                variant="danger"
                onPress={() => {
                  if (confirmation === "delete") state.submit();
                  else if (confirmation === "load") {
                    state.loadCurrent();
                    setCustomRole(false);
                  } else finish();
                  setConfirmation(null);
                }}
              />
              <AppButton
                label={
                  confirmation === "delete" ? "Keep crew member" : "Keep draft"
                }
                variant="secondary"
                onPress={() => setConfirmation(null)}
              />
            </View>
          ) : null}
        </ScrollView>
      </Page>
    </Modal>
  );
}
const useStyles = createThemedStyles((colors) =>
  StyleSheet.create({
    header: { flexDirection: "row", alignItems: "center", gap: 12 },
    copy: { flex: 1, minWidth: 0, gap: 4 },
    eyebrow: {
      color: colors.amberText,
      fontFamily,
      fontSize: 11,
      fontWeight: "900",
    },
    title: { color: colors.text, fontFamily, fontSize: 21, fontWeight: "900" },
    close: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 13,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.panel,
    },
    content: { paddingTop: spacing.large, paddingBottom: 48, gap: 14 },
    hint: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21 },
    error: { color: colors.red, fontFamily, fontSize: 14, lineHeight: 21 },
    label: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "700" },
    roles: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    role: {
      minHeight: 44,
      padding: 12,
      justifyContent: "center",
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    selected: { borderColor: colors.amber, backgroundColor: colors.amberSoft },
    confirmation: {
      gap: 12,
      paddingTop: 16,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    photo: {
      height: 92,
      width: 92,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 46,
      overflow: "hidden",
      backgroundColor: colors.amberSoft,
    },
    photoImage: { height: 92, width: 92 },
  }),
);

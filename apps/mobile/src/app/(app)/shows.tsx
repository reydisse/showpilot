import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Plus from "lucide-react-native/icons/plus";
import X from "lucide-react-native/icons/x";
import RadioTower from "lucide-react-native/icons/radio-tower";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Redirect, router } from "expo-router";
import * as Haptics from "@/lib/haptics";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { Page } from "@/components/page";
import { FeatureLink } from "@/components/feature-link";
import { ShowCard } from "@/components/show-card";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { createMobileRundown } from "@/lib/mobile-api";
import { createLocalRequestId } from "@/lib/request-id";
import { getServiceDateForTimeZone, isServiceDate } from "@/lib/service-time";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

interface CreateShowDraft {
  requestId: string;
  serviceDate: string;
  name: string;
  startTime: string;
  location: string;
}

export default function ShowsScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { organization, data, isPending, error, refetch } = useMobileBootstrap();
  const [creating, setCreating] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const timeZone = data?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const canCreate = Boolean(data?.identity.permissions.includes("schedule:manage"));
  const canViewLiveShow = Boolean(data?.identity.permissions.includes("show:view"));
  const createMutation = useMutation({
    mutationFn: (draft: CreateShowDraft) => createMobileRundown({
      orgId: organization!.id,
      requestId: draft.requestId,
      serviceDate: draft.serviceDate,
      name: draft.name.trim(),
      startTime: draft.startTime.trim() || undefined,
      location: draft.location.trim() || undefined,
    }),
    onSuccess: async (result) => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCreating(false);
      await queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap", organization?.id] });
      router.push({ pathname: "/show/[showId]", params: { showId: result.showId } });
    },
    onError: (createError) => {
      Alert.alert("Show not created", createError.message);
    },
  });
  if (!organization) return <Redirect href="/organizations" />;

  async function refreshShows() {
    setManualRefreshing(true);
    try {
      await refetch();
    } finally {
      setManualRefreshing(false);
    }
  }

  return (
    <Page
      eyebrow="RUNDOWNS"
      title="Shows"
      subtitle={`Upcoming and active shows for ${organization.name}.`}
      scroll={false}
      action={canCreate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create show"
          onPress={() => setCreating(true)}
          style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
        >
          <Plus color={colors.black} size={21} />
        </Pressable>
      ) : null}
    >
      <FlatList
        contentContainerStyle={styles.list}
        data={data?.shows ?? []}
        initialNumToRender={10}
        keyExtractor={(show) => show.id}
        ListHeaderComponent={(
          <View style={styles.listHeader}>
            {canViewLiveShow ? <FeatureLink icon={RadioTower} title="Open Live Show" description="One synchronized workspace for the live timer, cues, crew, chat, and full rundown." badge="LIVE" onPress={() => router.push("/live-show")} /> : null}
            {isPending ? <ActivityIndicator color={colors.amberText} size="large" /> : null}
            {error ? <Text onPress={() => refetch()} style={styles.error}>{error.message}{"\n"}<Text style={styles.retry}>Tap to retry</Text></Text> : null}
          </View>
        )}
        ListEmptyComponent={data && !isPending ? (
          <Text style={styles.empty}>
            {canCreate ? "No upcoming shows. Tap + to schedule the first one." : "There are no upcoming shows in this workspace."}
          </Text>
        ) : null}
        maxToRenderPerBatch={10}
        onRefresh={() => void refreshShows()}
        refreshing={manualRefreshing}
        renderItem={({ item: show }) => (
          <ShowCard show={show} timeZone={timeZone} onPress={() => router.push({ pathname: "/show/[showId]", params: { showId: show.id } })} />
        )}
        windowSize={7}
      />
      {creating && data ? (
        <CreateShowModal
          timeZone={data.timeZone}
          pending={createMutation.isPending}
          onClose={() => setCreating(false)}
          onCreate={(draft) => createMutation.mutate(draft)}
        />
      ) : null}
    </Page>
  );
}

function CreateShowModal({
  timeZone,
  pending,
  onClose,
  onCreate,
}: {
  timeZone: string;
  pending: boolean;
  onClose: () => void;
  onCreate: (draft: CreateShowDraft) => void;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [serviceDate, setServiceDate] = useState(() => getServiceDateForTimeZone(timeZone));
  const [requestId] = useState(() => createLocalRequestId("show"));
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("");
  const [location, setLocation] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const dateValid = isServiceDate(serviceDate);
  const timeValid = !startTime || /^([01]\d|2[0-3]):[0-5]\d$/.test(startTime);
  const nameValid = name.trim().length > 0;

  const submit = () => {
    setSubmitted(true);
    if (!dateValid || !timeValid || !nameValid) return;
    onCreate({ requestId, serviceDate, name, startTime, location });
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      transparent
      visible
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.modalOverlay}
      >
        <View accessibilityViewIsModal style={styles.modalSheet}>
          <View style={styles.modalHeader}>
            <View style={styles.modalHeading}>
              <Text style={styles.modalEyebrow}>NEW SHOW</Text>
              <Text style={styles.modalTitle}>Schedule a show</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close create show"
              disabled={pending}
              hitSlop={8}
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <X color={colors.textMuted} size={21} />
            </Pressable>
          </View>
          <ScrollView
            automaticallyAdjustKeyboardInsets
            contentContainerStyle={styles.modalForm}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.modalCopy}>
              Create it here and every web, desktop, and mobile operator will see the same show.
            </Text>
            <AppField
              label="Service title"
              autoCapitalize="words"
              maxLength={120}
              onChangeText={setName}
              placeholder="Sunday Morning Service"
              returnKeyType="next"
              value={name}
              error={submitted && !nameValid ? "Enter a service title." : undefined}
            />
            <AppField
              label="Service date"
              autoCorrect={false}
              inputMode="numeric"
              maxLength={10}
              onChangeText={setServiceDate}
              placeholder="YYYY-MM-DD"
              value={serviceDate}
              error={submitted && !dateValid ? "Use a real date in YYYY-MM-DD format." : undefined}
            />
            <AppField
              label="Start time (optional)"
              autoCorrect={false}
              inputMode="numeric"
              maxLength={5}
              onChangeText={setStartTime}
              placeholder="09:00"
              value={startTime}
              error={submitted && !timeValid ? "Use 24-hour HH:MM format." : undefined}
            />
            <AppField
              label="Location (optional)"
              autoCapitalize="words"
              maxLength={240}
              onChangeText={setLocation}
              placeholder="Main auditorium"
              value={location}
            />
            <View style={styles.modalActions}>
              <AppButton disabled={pending} label="Cancel" onPress={onClose} style={styles.modalAction} variant="secondary" />
              <AppButton label="Create show" loading={pending} onPress={submit} style={styles.modalAction} />
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  addButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: colors.amber },
  list: { gap: 12, paddingBottom: spacing.large },
  listHeader: { gap: spacing.medium, marginBottom: 2 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.large },
  error: { color: colors.red, fontFamily, fontSize: 13, lineHeight: 21 },
  retry: { color: colors.amberText, fontWeight: "700" },
  modalOverlay: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  modalSheet: { width: "100%", maxWidth: 620, maxHeight: "92%", alignSelf: "center", overflow: "hidden", borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.border, backgroundColor: colors.stageRaised, paddingTop: spacing.large },
  modalHeader: { flexDirection: "row", alignItems: "center", gap: spacing.medium, paddingHorizontal: spacing.large, paddingBottom: spacing.medium },
  modalHeading: { flex: 1, gap: 4 },
  modalEyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  modalTitle: { color: colors.text, fontFamily, fontSize: 22, fontWeight: "800" },
  closeButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  modalForm: { gap: spacing.medium, paddingHorizontal: spacing.large, paddingBottom: spacing.xlarge },
  modalCopy: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20 },
  modalActions: { flexDirection: "row", gap: spacing.small, paddingTop: spacing.small },
  modalAction: { flex: 1 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
}));

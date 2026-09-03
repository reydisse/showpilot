import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Camera from "lucide-react-native/icons/camera";
import Pencil from "lucide-react-native/icons/pencil";
import Search from "lucide-react-native/icons/search";
import Trash2 from "lucide-react-native/icons/trash-2";
import UserPlus from "lucide-react-native/icons/user-plus";
import UserRound from "lucide-react-native/icons/user-round";
import UsersRound from "lucide-react-native/icons/users-round";
import X from "lucide-react-native/icons/x";
import { Redirect } from "expo-router";
import { File } from "expo-file-system";
import * as Haptics from "@/lib/haptics";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { AppButton } from "@/components/app-button";
import { LoadingView } from "@/components/loading-view";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import {
  createMobileTeamCrewMember,
  getMobileTeamCrew,
  removeMobileTeamCrewMember,
  resolveMobileAvatarUrl,
  updateMobileTeamCrewMember,
  type MobileTeamCrewMember,
} from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

const builtInRoles = [
  "Production Director",
  "Production Manager",
  "Stage Manager",
  "Technical Director",
  "Audio Engineer",
  "Broadcast Mixer",
  "FOH Engineer",
  "Monitor Engineer",
  "Camera Director",
  "Camera Operator",
  "Graphics Operator",
  "Lighting Director",
  "Lighting Operator",
  "Streaming Director",
  "Stream Operator",
  "ProPresenter Operator",
];

function crewPhotoUri(value: string): string | null {
  if (/^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+=*$/i.test(value)) return value;
  return resolveMobileAvatarUrl(value);
}

export default function TeamCrewScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const [search, setSearch] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MobileTeamCrewMember | null>(null);
  const [memberId, setMemberId] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [email, setEmail] = useState("");
  const [photoUrl, setPhotoUrl] = useState("");
  const [customRoleOpen, setCustomRoleOpen] = useState(false);
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const queryKey = ["mobile-team-crew", organization?.id];
  const query = useQuery({
    queryKey,
    queryFn: () => getMobileTeamCrew(organization!.id),
    enabled: Boolean(organization?.id),
    refetchInterval: 15_000,
  });
  const filteredMembers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return query.data?.members ?? [];
    return (query.data?.members ?? []).filter((member) =>
      member.name.toLowerCase().includes(needle)
      || member.role.toLowerCase().includes(needle)
      || member.memberId.toLowerCase().includes(needle)
      || member.email.toLowerCase().includes(needle),
    );
  }, [query.data?.members, search]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const input = {
        orgId: organization!.id,
        memberId: memberId.trim().toUpperCase(),
        name: name.trim(),
        role: role.trim(),
        email: email.trim().toLowerCase(),
        photoUrl,
      };
      return editing
        ? updateMobileTeamCrewMember({ ...input, id: editing.id })
        : createMobileTeamCrewMember(input);
    },
    onSuccess: async () => {
      setEditorOpen(false);
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["mobile-checkin"] });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (error) => Alert.alert("Crew member not saved", error.message),
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => removeMobileTeamCrewMember({ orgId: organization!.id, id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["mobile-checkin"] });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (error) => Alert.alert("Crew member not removed", error.message),
  });

  if (organizationPending) return <LoadingView label="Opening crew roster…" />;
  if (!organization) return <Redirect href="/organizations" />;

  function openEditor(member?: MobileTeamCrewMember) {
    setEditing(member ?? null);
    setMemberId(member?.memberId ?? "");
    setName(member?.name ?? "");
    setRole(member?.role ?? "");
    setEmail(member?.email ?? "");
    setPhotoUrl(member?.photoUrl ?? "");
    setCustomRoleOpen(Boolean(member?.role && !builtInRoles.includes(member.role)));
    setEditorOpen(true);
  }

  async function choosePhoto() {
    setPreparingPhoto(true);
    try {
      const selection = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 1,
      });
      if (selection.canceled) return;
      const processed = await ImageManipulator.manipulateAsync(
        selection.assets[0].uri,
        [{ resize: { width: 480, height: 480 } }],
        { compress: 0.76, format: ImageManipulator.SaveFormat.JPEG },
      );
      const base64 = await new File(processed.uri).base64();
      setPhotoUrl(`data:image/jpeg;base64,${base64}`);
    } catch (error) {
      Alert.alert("Photo not prepared", error instanceof Error ? error.message : "Choose another image.");
    } finally {
      setPreparingPhoto(false);
    }
  }

  function confirmRemove(member: MobileTeamCrewMember) {
    Alert.alert(
      "Remove crew member?",
      `${member.name} will be removed from the production roster. Existing schedule positions will become unassigned.`,
      [
        { text: "Keep member", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => removeMutation.mutate(member.id) },
      ],
    );
  }

  const formReady = memberId.trim() && name.trim() && role.trim() && !preparingPhoto;
  const onlineCount = query.data?.members.filter((member) => member.isOnline).length ?? 0;

  return (
    <Page
      backTo="/(app)/operations"
      backLabel="Back to operations"
      eyebrow="TEAM CONTROL"
      title="Crew roster"
      scroll={false}
      action={(
        <Pressable accessibilityRole="button" onPress={() => openEditor()} style={styles.addButton}>
          <UserPlus color={colors.black} size={17} />
          <Text style={styles.addButtonText}>Add</Text>
        </Pressable>
      )}
    >
      <FlatList
        contentContainerStyle={styles.list}
        data={filteredMembers}
        initialNumToRender={12}
        keyExtractor={(member) => member.id}
        ListHeaderComponent={(
          <View style={styles.headerContent}>
            {query.isPending ? <ActivityIndicator color={colors.amberText} size="large" /> : null}
            {query.error ? <Text onPress={() => query.refetch()} style={styles.error}>{query.error.message} · Tap to retry</Text> : null}
            <View style={styles.summaryCard}>
              <UsersRound color={colors.blue} size={22} />
              <View style={styles.summaryCopy}>
                <Text style={styles.summaryTitle}>{query.data?.members.length ?? 0} crew · {onlineCount} checked in</Text>
                <Text style={styles.summaryText}>This production roster drives badges, check-in, assignments, and call-time messages.</Text>
              </View>
            </View>
            <View style={styles.searchBox}>
              <Search color={colors.textFaint} size={18} />
              <TextInput
                accessibilityLabel="Search crew roster"
                autoCapitalize="none"
                onChangeText={setSearch}
                placeholder="Search name, role, email, or member ID"
                placeholderTextColor={colors.textFaint}
                style={styles.searchInput}
                value={search}
              />
              {search ? <Pressable accessibilityLabel="Clear crew search" hitSlop={8} onPress={() => setSearch("")}><X color={colors.textFaint} size={17} /></Pressable> : null}
            </View>
            <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>PRODUCTION CREW</Text><Text style={styles.sectionCount}>{filteredMembers.length}</Text></View>
          </View>
        )}
        ListEmptyComponent={query.data && !query.isPending ? (
          <View style={styles.emptyCard}>
            <UserRound color={colors.textFaint} size={25} />
            <Text style={styles.emptyTitle}>{search ? "No matching crew" : "No crew members yet"}</Text>
            <Text style={styles.emptyText}>{search ? "Try another name, role, email, or ID." : "Add the people who serve on your production team."}</Text>
          </View>
        ) : null}
        maxToRenderPerBatch={12}
        onRefresh={() => void query.refetch()}
        refreshing={query.isRefetching}
        renderItem={({ item: member }) => {
          const photo = crewPhotoUri(member.photoUrl);
          return (
            <View style={styles.memberCard}>
              <View>
                {photo ? <Image source={{ uri: photo }} style={styles.avatar} /> : (
                  <View style={styles.avatarFallback}><Text style={styles.avatarText}>{member.name.charAt(0).toUpperCase()}</Text></View>
                )}
                <View style={[styles.statusDot, member.isOnline ? styles.statusOnline : styles.statusOffline]} />
              </View>
              <View style={styles.memberCopy}>
                <View style={styles.nameRow}><Text numberOfLines={1} style={styles.memberName}>{member.name}</Text><Text style={styles.memberId}>{member.memberId}</Text></View>
                <Text numberOfLines={1} style={styles.memberRole}>{member.role}</Text>
                {member.email ? <Text numberOfLines={1} style={styles.memberEmail}>{member.email}</Text> : null}
              </View>
              <View style={styles.actions}>
                <Pressable accessibilityLabel={`Edit ${member.name}`} onPress={() => openEditor(member)} style={styles.iconButton}><Pencil color={colors.textMuted} size={17} /></Pressable>
                <Pressable accessibilityLabel={`Remove ${member.name}`} disabled={removeMutation.isPending} onPress={() => confirmRemove(member)} style={styles.iconButton}><Trash2 color={colors.red} size={17} /></Pressable>
              </View>
            </View>
          );
        }}
        windowSize={7}
      />

      <Modal animationType="slide" onRequestClose={() => setEditorOpen(false)} transparent visible={editorOpen}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View><Text style={styles.modalTitle}>{editing ? "Edit crew member" : "Add crew member"}</Text><Text style={styles.modalSubtitle}>Roster and check-in identity</Text></View>
              <Pressable accessibilityLabel="Close crew member form" hitSlop={10} onPress={() => setEditorOpen(false)} style={styles.closeButton}><X color={colors.textMuted} size={20} /></Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
              <Pressable accessibilityRole="button" accessibilityLabel="Choose crew photo" disabled={preparingPhoto} onPress={choosePhoto} style={styles.photoPicker}>
                {crewPhotoUri(photoUrl) ? <Image source={{ uri: crewPhotoUri(photoUrl)! }} style={styles.photoPreview} /> : <UserRound color={colors.amberText} size={31} />}
                <View style={styles.cameraBadge}><Camera color={colors.black} size={13} /></View>
              </Pressable>
              <Text style={styles.photoHint}>{preparingPhoto ? "Preparing photo…" : "Tap to choose a square photo"}</Text>
              <Text style={styles.label}>MEMBER ID</Text>
              <TextInput accessibilityLabel="Crew member ID" autoCapitalize="characters" maxLength={128} onChangeText={(value) => setMemberId(value.toUpperCase())} placeholder="TD3917" placeholderTextColor={colors.textFaint} style={styles.input} value={memberId} />
              <Text style={styles.hint}>Used for badge scanning and quick check-in.</Text>
              <Text style={styles.label}>FULL NAME</Text>
              <TextInput accessibilityLabel="Crew member name" autoCapitalize="words" maxLength={200} onChangeText={setName} placeholder="Sarah Johnson" placeholderTextColor={colors.textFaint} style={styles.input} value={name} />
              <Text style={styles.label}>EMAIL · OPTIONAL</Text>
              <TextInput accessibilityLabel="Crew member email" autoCapitalize="none" autoComplete="email" inputMode="email" maxLength={254} onChangeText={setEmail} placeholder="crew@example.com" placeholderTextColor={colors.textFaint} style={styles.input} value={email} />
              <Text style={styles.hint}>Used for accountless schedule requests and reminders.</Text>
              <Text style={styles.label}>ROLE</Text>
              <View style={styles.roleChoices}>
                {builtInRoles.map((item) => (
                  <Pressable key={item} onPress={() => { setRole(item); setCustomRoleOpen(false); }} style={[styles.roleChoice, role === item && !customRoleOpen && styles.roleChoiceActive]}>
                    <Text style={[styles.roleChoiceText, role === item && !customRoleOpen && styles.roleChoiceTextActive]}>{item}</Text>
                  </Pressable>
                ))}
                <Pressable onPress={() => { setCustomRoleOpen(true); if (builtInRoles.includes(role)) setRole(""); }} style={[styles.roleChoice, customRoleOpen && styles.roleChoiceActive]}><Text style={[styles.roleChoiceText, customRoleOpen && styles.roleChoiceTextActive]}>Custom role</Text></Pressable>
              </View>
              {customRoleOpen ? <TextInput accessibilityLabel="Custom crew role" maxLength={100} onChangeText={setRole} placeholder="Set Builder" placeholderTextColor={colors.textFaint} style={styles.input} value={role} /> : null}
              <AppButton label={editing ? "Update crew member" : "Add crew member"} loading={saveMutation.isPending} disabled={!formReady} onPress={() => saveMutation.mutate()} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  list: { gap: 10, paddingBottom: spacing.large },
  headerContent: { gap: spacing.medium, paddingBottom: 2 },
  addButton: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 7, borderRadius: radii.small, backgroundColor: colors.amber, paddingHorizontal: 13 },
  addButtonText: { color: colors.black, fontFamily, fontSize: 11, fontWeight: "900" },
  summaryCard: { flexDirection: "row", alignItems: "flex-start", gap: 12, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.medium },
  summaryCopy: { flex: 1, gap: 4 },
  summaryTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "900" },
  summaryText: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 17 },
  searchBox: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 13 },
  searchInput: { flex: 1, color: colors.text, fontFamily, fontSize: 13 },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.2 },
  sectionCount: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800" },
  memberCard: { minHeight: 82, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: 11 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.panelStrong },
  avatarFallback: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 24, backgroundColor: colors.amberSoft },
  avatarText: { color: colors.amberText, fontFamily, fontSize: 17, fontWeight: "900" },
  statusDot: { position: "absolute", right: 0, bottom: 0, width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: colors.stageRaised },
  statusOnline: { backgroundColor: colors.green },
  statusOffline: { backgroundColor: colors.textFaint },
  memberCopy: { flex: 1, minWidth: 0, gap: 3 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  memberName: { flexShrink: 1, color: colors.text, fontFamily, fontSize: 13, fontWeight: "800" },
  memberId: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800", borderRadius: 5, backgroundColor: colors.panel, paddingHorizontal: 5, paddingVertical: 2 },
  memberRole: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800" },
  memberEmail: { color: colors.textMuted, fontFamily, fontSize: 11 },
  actions: { flexDirection: "row", gap: 4 },
  iconButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 11, backgroundColor: colors.panel },
  emptyCard: { alignItems: "center", gap: 8, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.xlarge },
  emptyTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "800" },
  emptyText: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 17, textAlign: "center" },
  error: { color: colors.red, fontFamily, fontSize: 12, textAlign: "center" },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  modalCard: { maxHeight: "94%", borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, paddingTop: spacing.medium },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: spacing.large, paddingBottom: spacing.medium },
  modalTitle: { color: colors.text, fontFamily, fontSize: 18, fontWeight: "900" },
  modalSubtitle: { color: colors.textMuted, fontFamily, fontSize: 11, marginTop: 3 },
  closeButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: colors.panel },
  form: { gap: 10, paddingHorizontal: spacing.large, paddingBottom: spacing.xlarge },
  photoPicker: { width: 82, height: 82, alignSelf: "center", alignItems: "center", justifyContent: "center", borderRadius: 25, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  photoPreview: { width: 82, height: 82, borderRadius: 25 },
  cameraBadge: { position: "absolute", right: -4, bottom: -4, width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 10, borderWidth: 3, borderColor: colors.stageRaised, backgroundColor: colors.amber },
  photoHint: { color: colors.textMuted, fontFamily, fontSize: 11, textAlign: "center" },
  label: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.2, marginTop: 3 },
  input: { minHeight: 50, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, color: colors.text, fontFamily, fontSize: 13, paddingHorizontal: 12 },
  hint: { color: colors.textFaint, fontFamily, fontSize: 11, lineHeight: 13, marginTop: -6 },
  roleChoices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  roleChoice: { minHeight: 42, justifyContent: "center", borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 10, paddingVertical: 7 },
  roleChoiceActive: { borderColor: colors.amber, backgroundColor: colors.amberSoft },
  roleChoiceText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800" },
  roleChoiceTextActive: { color: colors.amberText },
}));

import { Redirect } from "expo-router";
import { LoadingView } from "@/components/loading-view";
import { authClient } from "@/lib/auth-client";

export default function Index() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return <LoadingView />;
  return <Redirect href={session ? "/organizations" : "/sign-in"} />;
}

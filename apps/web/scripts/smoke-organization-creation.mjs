import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorPassword, queryFixture }) => {
  const email = "second@display-smoke.invalid";
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const currentUrl = async () => (await browser("eval", "location.href")).result;
  const original = await queryFixture("SELECT * FROM app_setting WHERE orgId='display-smoke' ORDER BY id");
  await browser("open", `${origin}/login?signup=1`);
  await browser("fill", "#name", "Existing member");
  await browser("fill", "#email", email);
  await browser("fill", "#password", operatorPassword);
  await click("Create account");
  await browser("wait", "text=An account with this email already exists.");
  await click("Sign in to create an organization");
  assert.equal((await browser("get", "value", "#email")).value, email);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "text=Create another organization");
  assert.equal(new URL(await currentUrl()).searchParams.get("mode"), "new");

  await browser("fill", "#organization-name", "Second fixture team");
  await browser("wait", "text=available");
  await click("Create organization");
  await browser("wait", "text=What are you running?");
  const secondUrl = await currentUrl();
  const secondId = new URL(secondUrl).searchParams.get("orgId");
  assert.ok(secondId && secondId !== orgId);
  await browser("open", secondUrl);
  await browser("wait", "text=What are you running?");
  assert.deepEqual((await queryFixture("SELECT organizationId,role FROM member WHERE userId='smoke-second-operator'")).sort((a,b) => a.organizationId.localeCompare(b.organizationId)),
    [{ organizationId: orgId, role: "member" }, { organizationId: secondId, role: "owner" }].sort((a,b) => a.organizationId.localeCompare(b.organizationId)));

  // A scoped resume URL must not expose another organization's setup.
  await browser("open", `${origin}/setup?orgId=display-other`);
  await browser("wait", "text=Something went wrong");
  assert.equal((await browser("eval", "document.body.innerText.includes('What are you running?')")).result, false);
  await browser("open", `${origin}/${orgId}/show`);
  await click("Switch organization. Current organization: Display fixture");
  await click("New organization");
  await browser("wait", "text=Create another organization");
  await browser("fill", "#organization-name", "Third fixture team");
  await browser("wait", "text=available");
  // Lost-response retry now lives in smoke-organization-recovery.mjs, which
  // installs its transport fault before Better Auth captures fetch at startup.
  await click("Create organization");
  await browser("wait", "text=What are you running?");
  const thirdId = new URL(await currentUrl()).searchParams.get("orgId");
  assert.ok(thirdId && thirdId !== secondId && thirdId !== orgId);
  await browser("open", secondUrl);
  await browser("wait", "text=What are you running?");
  // Visiting the old team records this member's notification timezone; setup
  // must not otherwise change its settings or write onboarding checkpoints.
  assert.deepEqual(await queryFixture("SELECT * FROM app_setting WHERE orgId='display-smoke' AND key!='notification-timezone:smoke-second-operator' ORDER BY id"), original);
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM member WHERE userId='smoke-second-operator'"))[0].count, 3);
  await browser("eval", "fetch('/api/auth/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})");
  await browser("open", `${origin}/login?returnTo=${encodeURIComponent('/setup?mode=new')}`);
  await browser("fill", "#email", "unverified@display-smoke.invalid");
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "text=Verify your email to create an organization.");
  await browser("fill", "#organization-name", "Unverified fixture team");
  await browser("wait", "text=available");
  assert.equal((await browser("eval", "[...document.querySelectorAll('button')].find(button => button.textContent.includes('Create organization')).disabled")).result, true);
  assert.equal((await browser("eval", "fetch('/api/auth/organization/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Unverified team',slug:'unverified-fixture-team'})}).then(response=>response.status)")).result, 403);
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM member WHERE userId='smoke-unverified'"))[0].count, 0);
  console.log(JSON.stringify({ existingEmailSignIn: "passed", memberCreatesOrganization: "passed", ownerOnlyInNewOrganization: "passed", scopedResumeAfterRefresh: "passed", unrelatedOrganizationDenied: "passed", switcherCreatesAnotherOrganization: "passed", originalSettingsPreserved: "passed", verifiedEmailRequired: "passed" }, null, 2));
}, { secondOperator: true, secondOperatorMember: true, unverifiedOperator: true });

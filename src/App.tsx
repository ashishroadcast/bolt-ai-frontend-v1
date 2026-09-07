import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./auth/RequireAuth.tsx";
import { ChatProvider } from "./chat/ChatContext.tsx";
import { Shell } from "./shell/Shell.tsx";
import { SignInRoute } from "./routes/SignInRoute.tsx";
import { DashboardRoute } from "./routes/DashboardRoute.tsx";
import { AskRoute } from "./routes/AskRoute.tsx";
import { DocumentsRoute } from "./routes/DocumentsRoute.tsx";
import { DatabasesRoute } from "./routes/DatabasesRoute.tsx";
import { AgentsRoute } from "./routes/AgentsRoute.tsx";
import { AgentDetailRoute } from "./routes/AgentDetailRoute.tsx";
import { ConfigTab } from "./routes/agentDetail/ConfigTab.tsx";
import { PromptsTab } from "./routes/agentDetail/PromptsTab.tsx";
import { TestsTab } from "./routes/agentDetail/TestsTab.tsx";
import { LearningTab } from "./routes/agentDetail/LearningTab.tsx";
import { OrchestratorsRoute } from "./routes/OrchestratorsRoute.tsx";
import { SettingsRoute } from "./routes/SettingsRoute.tsx";
import { ChannelsRoute } from "./routes/ChannelsRoute.tsx";
import { ArtifactsRoute } from "./routes/ArtifactsRoute.tsx";
import { CodeExecutionsRoute } from "./routes/CodeExecutionsRoute.tsx";
import { AuditRoute } from "./routes/AuditRoute.tsx";
import { McpServersRoute } from "./routes/McpServersRoute.tsx";
import { ModelsRoute } from "./routes/ModelsRoute.tsx";

function App() {
  return (
    <Routes>
      <Route path="sign-in" element={<SignInRoute />} />
      <Route
        element={
          <RequireAuth>
            {/* Above the router, not inside AskRoute: a run must survive
                navigating away from /ask rather than aborting — see
                ChatContext.tsx's own docstring. (Composer itself moved off
                Shell's global chrome onto AskRoute — see Shell.module.css's
                own docstring — but the provider still has to outlive route
                changes for that guarantee to hold.) */}
            <ChatProvider>
              <Shell />
            </ChatProvider>
          </RequireAuth>
        }
      >
        {/* The default route (redesign brief: "there is no landing page...
            build one; it is the first screen anyone sees"). Ask used to be
            it — an empty composer with nothing to orient a new session by. */}
        <Route index element={<DashboardRoute />} />
        <Route path="ask" element={<AskRoute />} />
        <Route path="documents" element={<DocumentsRoute />} />
        <Route path="databases" element={<DatabasesRoute />} />
        {/* Prompts and test suites now live as tabs on the agent detail
            page (task brief: "a prompt is not a standalone object: it
            belongs to one agent and one phase" — same for a test suite).
            These two old URLs may still be bookmarked or linked from
            outside the app, so they redirect to Agents rather than 404 or
            silently fall through to the generic "*" catch-all's /ask. */}
        <Route path="prompts" element={<Navigate to="/agents" replace />} />
        <Route path="test-suites" element={<Navigate to="/agents" replace />} />
        <Route path="agents" element={<AgentsRoute />} />
        <Route path="agents/:agentId" element={<AgentDetailRoute />}>
          <Route index element={<Navigate to="config" replace />} />
          {/* The Run tab is gone — see AgentDetailRoute's own docstring
              for why a launcher that only forwarded to /ask was worse
              than /ask itself. The URL may be bookmarked, so it lands on
              the tab that replaced it as the default rather than 404. */}
          <Route path="run" element={<Navigate to="../config" replace />} />
          <Route path="config" element={<ConfigTab />} />
          <Route path="prompts" element={<PromptsTab />} />
          <Route path="tests" element={<TestsTab />} />
          <Route path="learning" element={<LearningTab />} />
        </Route>
        <Route path="orchestrators" element={<OrchestratorsRoute />} />
        {/* Not yet in Rail.tsx's nav — that file is mid-edit by the
            redesign task (Rail.module.css still reads the two deprecated
            colour aliases tokens.css's own docstring names), so this
            route is reachable by URL but not yet linked from the sidebar.
            See this task's report. */}
        <Route path="settings" element={<SettingsRoute />} />
        {/* Channels, Artifacts and Audit (this task): app.api.channels and
            app.api.artifacts were already mounted on app.main with no
            screen calling either, and config_audit had a writer
            (record_config_write) and no reader anywhere. Same as
            /settings just above, Rail.tsx is held by the redesign task
            right now, so these three are reachable by URL but not yet
            linked from the sidebar — see this task's own report. */}
        <Route path="channels" element={<ChannelsRoute />} />
        <Route path="artifacts" element={<ArtifactsRoute />} />
        {/* Saurabh's own "inspect is empty — where can i see if agent did
            any code execution?". `code_executions` had a writer since
            Phase 4 and no reader anywhere, so a run that computed an
            answer without also writing a file left nothing to look at.
            Like /settings, /channels and /artifacts above, Rail.tsx is
            held by another task right now, so this is reachable by URL
            but not yet linked from the sidebar — see this task's report. */}
        <Route path="code-executions" element={<CodeExecutionsRoute />} />
        <Route path="audit" element={<AuditRoute />} />
        {/* app.api.mcp_servers was mounted with no screen ever calling it —
            the last Connections surface that was planned and never built
            (this task's brief, Saurabh's own "where can i see mcp server
            list?"). Linked from Rail.tsx's Connections group directly,
            unlike the three routes just above at the time they landed. */}
        <Route path="mcp-servers" element={<McpServersRoute />} />
        <Route path="models" element={<ModelsRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default App;

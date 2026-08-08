"use client";
import { useState } from "react";
import {
  Bell,
  ChevronDown,
  Play,
  Search,
  Send,
  Share2,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import {
  AppShell,
  Avatar,
  Bubble,
  Button,
  Card,
  CenterPane,
  Chip,
  CodeBlock,
  Drawer,
  Field,
  IconButton,
  Input,
  Modal,
  Panel,
  Rail,
  Readout,
  SectionTitle,
  Select,
  SlideOver,
  StatusBar,
  StatusDot,
  SystemNotice,
  Tab,
  TabGroup,
  Textarea,
  TitleBar,
  ToolCard,
} from "@/app/components/ui";

// Dev-only gallery: every primitive rendered in both themes so the whole
// system is previewable in isolation without touching the live dashboard.
// Reachable at /ui-gallery. The token vars cascade per subtree, so a nested
// [data-theme] wrapper re-skins everything inside it.

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>{title}</SectionTitle>
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </div>
  );
}

function Specimens({ container }: { container: HTMLElement | null }) {
  const [modal, setModal] = useState(false);
  const [slide, setSlide] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [tab, setTab] = useState("view");

  return (
    <div className="flex flex-col gap-8 p-6 bg-window text-ink-soft rounded-window border border-divider">
      <Group title="Buttons">
        <Button variant="accent">
          <Send className="w-4 h-4" /> Send
        </Button>
        <Button variant="pill">
          <Share2 className="w-4 h-4" /> Share
        </Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="accent" size="sm">
          Run
        </Button>
        <Button variant="pill" size="sm">
          Rename
        </Button>
        <Button variant="accent" disabled>
          Disabled
        </Button>
        <IconButton label="Search">
          <Search className="w-4 h-4" />
        </IconButton>
        <IconButton label="Notifications">
          <Bell className="w-4 h-4" />
        </IconButton>
      </Group>

      <Group title="Chips">
        <Chip>hooop</Chip>
        <Chip tone="accent">accent</Chip>
        <Chip tone="live">live</Chip>
        <Chip tone="wrap">wrap</Chip>
        <Chip tone="sdk">sdk</Chip>
        <Chip tone="direct">direct</Chip>
        <Chip tone="fail">fail</Chip>
      </Group>

      <Group title="Status dots">
        <span className="inline-flex items-center gap-1.5 text-xs">
          <StatusDot state="live" pulse /> live
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs">
          <StatusDot state="wrap" /> wrap
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs">
          <StatusDot state="fail" /> fail
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs">
          <StatusDot state="idle" /> idle
        </span>
      </Group>

      <Group title="Avatars">
        <Avatar initials="BQ" size="sm" />
        <Avatar initials="BQ" />
        <Avatar initials="BQ" size="lg" ring="accent" />
        <Avatar ring="peer">
          <Sparkles className="w-4 h-4" />
        </Avatar>
      </Group>

      <Group title="Readouts">
        <Readout tone="accent" size="lg">
          128,402
        </Readout>
        <Readout tone="wrap">1m 41s</Readout>
        <Readout tone="mute" size="sm">
          pid 48213
        </Readout>
      </Group>

      <Group title="Fields">
        <div className="w-64">
          <Field label="Session name" hint="Shown in the rail">
            <Input placeholder="untitled session" />
          </Field>
        </div>
        <div className="w-64">
          <Field label="Model">
            <Select defaultValue="opus">
              <option value="opus">Opus 4.8</option>
              <option value="sonnet">Sonnet 5</option>
              <option value="haiku">Haiku 4.5</option>
            </Select>
          </Field>
        </div>
        <div className="w-64">
          <Field label="Token" error="Required">
            <Input />
          </Field>
        </div>
        <div className="w-72">
          <Field label="Notes">
            <Textarea rows={2} placeholder="…" />
          </Field>
        </div>
      </Group>

      <Group title="Tabs">
        <TabGroup>
          <Tab active={tab === "view"} onClick={() => setTab("view")}>
            View
          </Tab>
          <Tab active={tab === "raw"} onClick={() => setTab("raw")}>
            Raw
          </Tab>
          <Tab active={tab === "json"} onClick={() => setTab("json")}>
            JSON
          </Tab>
        </TabGroup>
        <TabGroup>
          <Tab tone="neutral" active>
            bm25
          </Tab>
          <Tab tone="neutral">semantic</Tab>
          <Tab tone="neutral">hybrid</Tab>
        </TabGroup>
      </Group>

      <Group title="Panel + Card">
        <div className="w-72 h-56 border border-divider rounded-card overflow-hidden bg-rail">
          <Panel className="h-full">
            <Panel.Header
              icon={<Workflow className="w-4 h-4" />}
              title="Sub-agents"
              count={3}
              actions={
                <IconButton label="Expand" size="sm">
                  <ChevronDown className="w-3.5 h-3.5" />
                </IconButton>
              }
            />
            <Panel.Body className="flex flex-col gap-2">
              <Card padded={false} className="p-3 flex items-center gap-2">
                <StatusDot state="wrap" /> <span className="text-xs">explorer · done</span>
              </Card>
              <Card surface="sunken" className="p-3 text-xs text-ink-faint">
                sunken well
              </Card>
            </Panel.Body>
          </Panel>
        </div>
      </Group>

      <Group title="Chat">
        <div className="flex flex-col gap-2 w-full max-w-2xl">
          <SystemNotice>Session started</SystemNotice>
          <Bubble author="host">Can you refactor the auth guard?</Bubble>
          <Bubble author="assistant">On it — here's the plan.</Bubble>
          <Bubble author="peer">I'll review when it's ready.</Bubble>
          <Bubble author="assistant" wide>
            <CodeBlock lang="ts" code={"export const guard = (req: Req) => {\n  return req.user != null;\n};"} />
          </Bubble>
          <Bubble author="assistant" wide>
            <ToolCard name="Read(middleware.ts)" status={<StatusDot state="wrap" size="sm" />}>
              42 lines read
            </ToolCard>
          </Bubble>
        </div>
      </Group>

      <Group title="Overlays">
        <Button variant="pill" onClick={() => setModal(true)}>
          Open Modal
        </Button>
        <Button variant="pill" onClick={() => setSlide(true)}>
          Open SlideOver
        </Button>
        <Button variant="pill" onClick={() => setDrawer(true)}>
          Open Drawer
        </Button>
      </Group>

      <Modal open={modal} onClose={() => setModal(false)} label="Settings" container={container}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-divider">
          <SectionTitle className="text-[13px] normal-case tracking-normal text-ink">
            Settings
          </SectionTitle>
          <IconButton label="Close" size="sm" onClick={() => setModal(false)}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>
        <div className="p-5 flex flex-col gap-3">
          <Field label="Session name">
            <Input placeholder="untitled" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setModal(false)}>
              Cancel
            </Button>
            <Button variant="accent" onClick={() => setModal(false)}>
              Save
            </Button>
          </div>
        </div>
      </Modal>

      <SlideOver open={slide} onClose={() => setSlide(false)} label="Agent detail" container={container}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-divider">
          <SectionTitle className="text-[13px] normal-case tracking-normal text-ink">
            Agent detail
          </SectionTitle>
          <IconButton label="Close" size="sm" onClick={() => setSlide(false)}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>
        <div className="p-5 text-sm">Right-edge slide-over content.</div>
      </SlideOver>

      <Drawer open={drawer} onClose={() => setDrawer(false)} label="Events" container={container}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-divider">
          <SectionTitle className="text-[13px] normal-case tracking-normal text-ink">
            Events
          </SectionTitle>
          <IconButton label="Close" size="sm" onClick={() => setDrawer(false)}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>
        <div className="p-5 text-sm">Bottom drawer content.</div>
      </Drawer>
    </div>
  );
}

function ShellDemo() {
  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>App shell</SectionTitle>
      <div className="h-80 rounded-window overflow-hidden border border-divider">
        <AppShell className="h-full w-full p-0">
          <TitleBar>
            <span className="font-sans font-semibold text-ink">hooop</span>
            <div className="ml-auto flex items-center gap-2">
              <IconButton label="Search" size="sm">
                <Search className="w-4 h-4" />
              </IconButton>
              <Avatar initials="BQ" size="sm" />
            </div>
          </TitleBar>
          <div className="flex flex-1 min-h-0">
            <Rail side="left" className="w-44">
              <Panel className="h-full">
                <Panel.Header title="Sessions" count={2} />
                <Panel.Body className="flex flex-col gap-1 text-xs">
                  <div className="rounded-[11px] px-2 py-1.5 bg-accent/[0.14] text-ink flex items-center gap-2">
                    <StatusDot state="live" size="sm" pulse /> refactor
                  </div>
                  <div className="rounded-[11px] px-2 py-1.5 hover:bg-elevated flex items-center gap-2">
                    <StatusDot state="wrap" size="sm" /> docs
                  </div>
                </Panel.Body>
              </Panel>
            </Rail>
            <CenterPane>
              <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-2">
                <Bubble author="host">What's the status?</Bubble>
                <Bubble author="assistant">Two files changed, tests green.</Bubble>
              </div>
              <div className="p-3 border-t border-divider">
                <div className="flex items-center gap-2 bg-sunken border border-divider rounded-control px-3 py-2">
                  <input
                    className="flex-1 bg-transparent outline-none text-sm text-ink placeholder:text-ink-hush"
                    placeholder="Message the agent…"
                  />
                  <IconButton label="Send" size="sm">
                    <Send className="w-4 h-4 text-accent" />
                  </IconButton>
                </div>
              </div>
            </CenterPane>
            <Rail side="right" collapsible className="w-44">
              <Panel className="h-full">
                <Panel.Header icon={<Play className="w-4 h-4" />} title="Skills" />
                <Panel.Body className="text-xs text-ink-faint">idle</Panel.Body>
              </Panel>
            </Rail>
          </div>
          <StatusBar>
            <span>2 events</span>
            <span className="ml-auto">128k ctx</span>
          </StatusBar>
        </AppShell>
      </div>
    </div>
  );
}

// A static preview of each overlay's panel chrome, always visible (not
// portalled) so both themes read at a glance without opening anything. The
// live open/close/Esc/focus behavior is exercised by the buttons above.
function OverlayChrome({ title }: { title: string }) {
  return (
    <div className="w-72 rounded-window bg-window shadow-overlay overflow-hidden shrink-0">
      <div className="flex items-center justify-between px-5 py-4 border-b border-divider">
        <SectionTitle className="text-[13px] normal-case tracking-normal text-ink">
          {title}
        </SectionTitle>
        <IconButton label="Close" size="sm">
          <X className="w-4 h-4" />
        </IconButton>
      </div>
      <div className="p-5 text-sm text-ink-soft">Panel surface, divider, and ink.</div>
    </div>
  );
}

function ThemeColumn({ theme }: { theme: "dark" | "light" }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  return (
    <div ref={setContainer} data-theme={theme} className="flex-1 min-w-0 bg-bg p-6">
      <h2 className="font-sans text-sm font-semibold text-ink mb-4 uppercase tracking-wide">
        {theme}
      </h2>
      <div className="flex flex-col gap-8">
        <Specimens container={container} />
        <Group title="Overlay chrome (static preview)">
          <OverlayChrome title="Modal" />
          <OverlayChrome title="SlideOver" />
          <OverlayChrome title="Drawer" />
        </Group>
        <ShellDemo />
      </div>
    </div>
  );
}

export default function UiGalleryPage() {
  // Dev-only: not part of the shipped product surface.
  if (process.env.NODE_ENV === "production") return null;
  return (
    <div className="min-h-screen flex flex-col lg:flex-row" data-testid="ui-gallery">
      <ThemeColumn theme="dark" />
      <ThemeColumn theme="light" />
    </div>
  );
}

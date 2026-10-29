# Spec: Global Settings — Dashboard UI

## REQ-GS-UI-1: Global Settings Page

The dashboard MUST have a new page accessible from the sidebar for configuring installation-level settings.

### Scenario GS-UI-1a: Navigation

- **Given** the user is logged in
- **When** they click "Global Settings" in the sidebar
- **Then** the Global Settings page loads

### Scenario GS-UI-1b: Installation selector

- **Given** the user has access to multiple installations
- **When** they open the Global Settings page
- **Then** they can select which installation to configure (dropdown or similar)

### Scenario GS-UI-1c: Single installation

- **Given** the user has access to only one installation
- **When** they open the Global Settings page
- **Then** the installation is auto-selected (no dropdown needed)

### Scenario GS-UI-1d: Page content

- **Given** the Global Settings page is loaded for an installation
- **Then** it MUST show:
  - AI Review toggle (enable/disable)
  - Provider Chain Editor (reused component)
  - Review Mode selector (simple/workflow/consensus)
  - Static Analysis toggles (Semgrep, Trivy, CPD)
  - Memory toggle
  - Custom Rules and Ignore Patterns
  - Save button

### Scenario GS-UI-1e: First-time setup

- **Given** no installation settings exist yet
- **When** the page loads
- **Then** it shows defaults (AI enabled, empty chain, simple mode, all static analysis on)
- **And** a helpful message: "Configure your default settings. All repositories will inherit these unless overridden."

### Scenario GS-UI-1f: Save

- **Given** the user modifies settings and clicks Save
- **When** the save completes
- **Then** a success toast appears
- **And** the settings persist on page reload

## REQ-GS-UI-2: Per-Repo Settings Toggle

The existing Settings page MUST show a toggle for global vs custom settings.

### Scenario GS-UI-2a: Default state — using global

- **Given** a repo with `useGlobalSettings: true`
- **When** the Settings page loads
- **Then** it shows a toggle/switch: "Use global settings" (ON)
- **And** below it, the inherited settings are shown in a read-only view
- **And** a link/badge: "Edit in Global Settings →"

### Scenario GS-UI-2b: Switch to custom

- **Given** the toggle is ON (use global)
- **When** the user switches it OFF
- **Then** the form becomes editable
- **And** it pre-fills with the current global values as a starting point
- **And** a note: "This repo will use its own settings instead of inheriting from global."

### Scenario GS-UI-2c: Custom settings active

- **Given** a repo with `useGlobalSettings: false`
- **When** the Settings page loads
- **Then** the toggle shows "Use global settings" (OFF)
- **And** the full settings form is editable (same as current behavior)

### Scenario GS-UI-2d: Switch back to global

- **Given** the toggle is OFF (custom)
- **When** the user switches it ON
- **Then** the form becomes read-only showing inherited global values
- **And** the custom settings are NOT deleted (preserved for later)

## REQ-GS-UI-3: Sidebar Navigation Update

### Scenario GS-UI-3a: New nav item

- **Given** the dashboard sidebar
- **Then** it MUST include a "Global Settings" link with a distinct icon
- **And** it SHOULD appear above the repo-specific "Settings" link (logically: global first, then per-repo)

### Scenario GS-UI-3b: Active state

- **Given** the user is on the Global Settings page
- **Then** the "Global Settings" sidebar item is highlighted as active

## REQ-GS-UI-4: Visual Clarity

### Scenario GS-UI-4a: Inherited badge

- **Given** a repo using global settings
- **When** viewing the per-repo Settings page
- **Then** each section shows an "Inherited" badge or indicator

### Scenario GS-UI-4b: Override indicator in repo list

- **Given** the Dashboard or Settings page
- **When** a repo has custom settings (useGlobalSettings=false)
- **Then** it MAY show a small "Custom" badge to differentiate from global-inherited repos

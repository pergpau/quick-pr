# Quick PR

A VS Code extension that allows you to create pull requests from selected lines or staged changes with a single click.

## Features

- Creates a PR from changes you have selected or currently staged changes
- Automatically handles git operations:
  - Pulls latest from base branch
  - Creates new branch
  - Applies only selected changes
  - Commits and pushes
  - Creates GitHub PR
  - Returns to original branch
- Preserves your other work-in-progress changes

## Setup

1. Install the extension
2. Configure your Github username in settings.json (used for branch naming):
   - `quickPr.githubUsername`: "someusername"

## Usage

### From selection
1. Make some changes in your code
2. Select the lines you want to include in the PR
3. Right-click and select "Make PR from selection" OR use Command Palette
4. Enter your commit message (will also be used as PR title)
5. The extension will handle the rest!

### From staged changes
1. Make some changes in your code
2. Stage the changes
3. Use Command Palette and select "Make PR from staged changes"
4. Enter your commit message (will also be used as PR title)
5. The extension will handle the rest!


## How it Works

1. **Preserves your current work**: Stashes any uncommitted changes
2. **Pulls latest**: Switches to base branch and pulls latest changes
3. **Creates new branch**: Makes a new branch from the updated base
4. **Applies changes**: Only applies your selected/staged lines to the new branch
5. **Commits and pushes**: Commits with your message and pushes to origin
6. **Creates PR**: Opens the new PR screen on Github with the new branch
7. **Restores state**: Returns to your original branch and restores stashed changes

## Development

To set up for development:

```bash
npm install
npm run compile
```

To test the extension:
1. Open this folder in VS Code
2. Press F5 to launch Extension Development Host
3. Test your extension in the new window

## Known Issues

- Currently only supports GitHub repositories

## Release Notes

### 0.0.1

Initial release with basic PR creation functionality.
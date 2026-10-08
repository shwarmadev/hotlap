# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine,
create the second login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in. Existing
threads can switch only between Claude instances with the same config directory.
Separate account directories stay isolated, including their local conversation
state. Claude does not have Codex's shared-home and shadow-home arrangement.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

Claude Code's verbose mode can stay enabled when you use Claude for text generation, including
thread titles, branch names, commit messages, and pull request descriptions. On a remote connection,
T3 Code uses the Claude configuration on the connected server.

## Choose an account automatically

In project settings, choose a usage threshold and at least two Claude accounts,
then enable automatic account routing. Set a new thread to **Auto**. Use
**Fixed** when the thread must stay on the selected account.

Before the first normal message, T3 Code chooses the eligible account whose
weekly limit resets first. The usage report must be recent and include the
five-hour and seven-day reset times. Model-specific limits do not trigger a
change.

A started thread stays on its account until that account is blocked, because
moving starts Claude's prompt cache over. When a message hits a usage limit,
T3 Code copies the conversation to another account in the pool that is not at
its limit, even one past the switch threshold, and sends the message again
there. If every account is at its limit, the thread says when the soonest one
resets.

T3 Code never signs in, signs out, or changes which login an instance uses. If
another tool swaps the login in an instance's config directory, the thread picks
up the new login on its next message.

Authentication commands, `/compact`, approvals, answers, steering, and
background work never trigger a change. New queued prompts remain eligible when
they are sent. If an account cannot start, T3 Code tries the remaining eligible
accounts before falling back to a usable selected account.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter. When you return to a large thread
after more than an hour, the send button changes to **Compact and send**: Enter
summarizes the history first, then sends your message. To keep the full history
for that message, open the menu next to the button and choose **Send with full
history**. See [commands and skills](./composer.md#commands-and-skills) for using
composer commands.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code can hold the turn until that window reopens, so it can keep showing
as working. The warning's timestamp shows when the displayed wait started.

When a turn stops on a usage limit instead, T3 Code waits and asks Claude to
continue where it left off. It retries every 5 minutes and once just after the
reset, and gives up 30 minutes after the reset (6 hours when Claude gives no
reset time, and never more than 24 hours after the wait began). On a thread set
to **Auto**, another account gets the message first, and the wait starts only
when none can take it. A banner above the composer shows the wait; **Cancel** it
or send a message to end it early. Archiving, settling, or reverting the thread,
or moving it to another Claude provider, also ends it. Limits that reset more
than 12 hours away are not waited for. Turn this off with **Auto-resume after
usage limits** in general settings.

When Claude rejects a message outright on a usage limit, a thread set to
**Auto** moves to another account and sends it again (see
[Choose an account automatically](#choose-an-account-automatically)). A
**Fixed** thread keeps the error; send the message again after the reset.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Select the model you want in T3 Code. For an OpenRouter model outside the built-in
list, open that Claude instance in **Settings > Providers** and add its full model
ID with **Add custom model**. Then select it in the chat model picker.
`ANTHROPIC_DEFAULT_*_MODEL` variables map Claude Code aliases such as `sonnet`; they
do not replace the explicit model ID selected in T3 Code. Custom models may have
fewer effort, thinking, or context controls than built-in models.

Verify the model used in OpenRouter's activity dashboard. For current compatibility
requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.

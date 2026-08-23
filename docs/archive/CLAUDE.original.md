# Claude implementation guidance

Implement Bananasaurs as a general-purpose engineering-club assistant, not as a coding agent exposed to Discord.

If Claude Code or an agent SDK is explored as a provider adapter:

- place it behind the same provider/runtime boundary as other backends;
- replace coding-oriented instructions with `config/agent/bananasaurs.system.md`;
- expose only explicitly approved tools and directories;
- do not allow shell, filesystem, repository, or network powers merely because the underlying runtime supports them;
- confirm the current terms and authentication method before relying on subscription-backed access;
- keep a standard API provider path so the project does not depend on that experiment.

Start with the implementation brief, propose a short milestone plan, then build and test a vertical slice. Preserve intentional flexibility in low-level choices.


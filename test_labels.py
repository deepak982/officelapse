#!/usr/bin/env python3
"""Self-check for server.label(tool, input).  Run: python3 test_labels.py"""
import server


def main():
    L = server.label

    # --- Bash: name the command the worker actually runs ---------------------
    assert L("Bash", {"command": "ls"}) == "running ls"
    assert L("Bash", {"command": "ls -la /tmp"}) == "running ls"

    # the cd-prefix bug: must name the REAL command, never "cd"
    assert L("Bash", {"command": "cd /some/path && grep foo"}) == "running grep"
    assert L("Bash", {"command": "cd /a/b && cd /c && python3 x.py"}) == "running python3"
    assert L("Bash", {"command": "( cd /x && make )"}) == "running make"

    # leading variable assignments are peeled too
    assert L("Bash", {"command": "S=/tmp/x sed -n 1,5p f"}) == "running sed"
    assert L("Bash", {"command": "FOO=1 BAR=2 cd /z && awk NR==1"}) == "running awk"

    # nothing to run
    assert L("Bash", {"command": ""}) == "running a command"
    assert L("Bash", {"command": "   "}) == "running a command"
    assert L("Bash", {}) == "running a command"
    assert L("Bash", None) == "running a command"

    # an absolute binary path is reduced to its basename and capped
    out = L("Bash", {"command": "/usr/local/bin/somethingveryverylongname --x"})
    assert out.startswith("running somethingveryveryl"), out
    assert "/" not in out, out
    assert len(out) <= len("running ") + 18, out

    # --- file tools: basename only, never the full path ----------------------
    assert L("Read", {"file_path": "/a/b/c/server.py"}) == "reading server.py"
    assert L("Edit", {"file_path": "/x/y/index.html"}) == "editing index.html"
    assert L("Write", {"file_path": "/p/q/run.sh"}) == "writing run.sh"
    assert L("NotebookEdit", {"notebook_path": "/deep/nest/nb.ipynb"}) == "editing nb.ipynb"
    for t in ("Read", "Edit", "Write"):
        assert "/" not in L(t, {"file_path": "/very/deep/nested/path/file.ts"})
    assert L("Read", {}) == "reading ?"        # missing path degrades, never crashes

    # --- search tools mention what is searched for ---------------------------
    assert L("Grep", {"pattern": "def label"}) == "grepping def label"
    assert "def label" in L("Grep", {"pattern": "def label"})
    assert len(L("Grep", {"pattern": "x" * 60})) <= len("grepping ") + 24
    assert L("Glob", {"pattern": "**/*.py"}) == "hunting **/*.py"

    # --- delegation names the job or the agent type --------------------------
    assert L("Task", {"description": "Server self-check"}) == "briefing Server self-check"
    assert L("Task", {"subagent_type": "Explore"}) == "briefing Explore"
    assert L("Agent", {"description": "Hunt the bug"}) == "briefing Hunt the bug"
    assert L("Agent", {}) == "briefing a teammate"
    # description wins over subagent_type when both are present
    assert L("Task", {"description": "Fix tree", "subagent_type": "Explore"}) == "briefing Fix tree"

    # --- mcp tools are named by their server ---------------------------------
    assert L("mcp__foo__bar", {}) == "calling foo"
    assert L("mcp__plane__workitem", {}) == "calling plane"

    # --- odds and ends -------------------------------------------------------
    assert L("WebFetch", {}) == "looking it up online"
    assert L("WebSearch", {}) == "looking it up online"
    assert L("TodoWrite", {}) == "updating the plan"
    assert L("AskUserQuestion", {}) == "asking the boss"
    assert L("ExitPlanMode", {}) == "drawing up a plan"
    assert L("SendMessage", {"to": "Arjun"}) == "messaging Arjun"
    assert L("Skill", {"skill": "ponytail"}) == "reading the ponytail manual"
    assert L("Artifact", {}) == "publishing a page"

    # unknown tool names pass straight through
    assert L("TotallyUnknownTool", {}) == "TotallyUnknownTool"
    assert L("?", {}) == "?"

    print("labels ok")


if __name__ == "__main__":
    main()

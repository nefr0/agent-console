import json


def convert(lines):
    return "\n".join(json.dumps(json.loads(line)) for line in lines.splitlines())

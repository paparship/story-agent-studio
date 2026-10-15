"""Copy the explicit public source allowlist; never traverse private run histories."""
import json, shutil
from pathlib import Path
dest = Path(__file__).resolve().parents[1]
root = dest.parent
data = dest/'src/data'
data.mkdir(parents=True, exist_ok=True)
prompts = root/'workflow-design/prompts/v0.4'
bundle = {p.name: p.read_text(encoding='utf-8-sig') for p in prompts.glob('*.txt')}
bundle['manifest'] = json.loads((prompts/'manifest.json').read_text(encoding='utf-8'))
for name in ('catalog.json','capabilities.txt','dsl-reference.txt'):
    shutil.copyfile(root/'backend/resources'/name, data/name)
(data/'prompts.json').write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding='utf-8')
examples=[]
for name in ('a-message','b-investigation','c-meeting'):
    folder=root/'workflow-design/fixtures'/name
    examples.append(dict(id=name, story=(folder/'input.txt').read_text(encoding='utf-8-sig'), dsl=(folder/'expected.story').read_text(encoding='utf-8-sig')))
(data/'examples.json').write_text(json.dumps(examples, ensure_ascii=False, indent=2), encoding='utf-8')

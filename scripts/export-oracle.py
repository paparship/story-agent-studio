"""Development-only differential fixtures from the established Python compiler.
The shipped browser app never imports Python or invokes the local backend.
"""
import copy, json, sys, unittest
from pathlib import Path
root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'compiler'))
import storydsl, test_storydsl, test_independent
records = []
original = storydsl.compile_source
def capture(source, context, filename='<story>'):
    row = dict(source=source, filename=filename)
    try:
        package, mapping = original(source, context, filename)
        row.update(package=package, mapping=mapping)
        return package, mapping
    except storydsl.Diagnostic as e:
        row['error'] = e.as_dict()
        raise
    finally:
        records.append(row)
test_storydsl.compile_source = capture
test_independent.compile_source = capture
suite = unittest.TestSuite()
for module in (test_storydsl, test_independent):
    for group in unittest.defaultTestLoader.loadTestsFromModule(module):
        for test in group:
            if 'validator' not in test.id() and 'cli' not in test.id(): suite.addTest(test)
result = unittest.TextTestRunner(verbosity=0).run(suite)
for path in (root/'workflow-design/fixtures').glob('*/expected.story'):
    capture(path.read_text(encoding='utf-8-sig'), test_storydsl.CONTEXT, 'candidate.story')
dest = Path(__file__).resolve().parents[1]
(dest/'tests/fixtures').mkdir(parents=True, exist_ok=True)
(dest/'src/data').mkdir(parents=True, exist_ok=True)
(dest/'tests/fixtures/compiler-oracle.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
(dest/'src/data/context.json').write_text(json.dumps(test_storydsl.CONTEXT, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Exported {len(records)} differential cases')
validation = []
for case in json.loads((root/'configuration/tests/cases.json').read_text(encoding='utf-8-sig')):
    validation.append(dict(name=case['file'], valid=not case['error'], package=json.loads((root/'configuration/tests'/case['file']).read_text(encoding='utf-8-sig'))))
(dest/'tests/fixtures/validation-oracle.json').write_text(json.dumps(validation, ensure_ascii=False, indent=2), encoding='utf-8')
if not result.wasSuccessful(): sys.exit(1)

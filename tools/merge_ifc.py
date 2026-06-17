#!/usr/bin/env python3
"""
Merge multiple IFC files into one model for ifcviewer.

Each source file is labeled with its filename (stem) on IfcProject / IfcSite /
IfcBuilding before merge, so the viewer left panel (Storeys) shows source names
instead of the output filename repeated.

Usage:
  python merge_ifc.py merged.ifc file1.ifc file2.ifc ...
  python merge_ifc.py -o merged.ifc *.ifc
  python merge_ifc.py --list sources.txt -o merged.ifc

PowerShell does not expand *.ifc — the script expands globs itself.

Requires:
  pip install -r requirements.txt

Note: ifcpatch is a separate PyPI package (not bundled inside ifcopenshell).
"""

from __future__ import annotations

import argparse
import glob
import json
import shutil
import sys
import tempfile
from pathlib import Path

import ifcopenshell

try:
    import ifcpatch
except ImportError as exc:
    raise SystemExit(
        "Missing dependency 'ifcpatch'. Install both packages:\n"
        "  pip install -r requirements.txt\n"
        "or:\n"
        "  pip install ifcopenshell ifcpatch"
    ) from exc


SPATIAL_TYPES = ("IfcProject", "IfcSite", "IfcBuilding")
GENERIC_NAMES = {"", "Default", "Undefined", "Project", "Building", "Site"}


def display_name(path: Path) -> str:
    return path.stem


def label_spatial_roots(model: ifcopenshell.file, label: str) -> list[str]:
    """Set human-readable names on spatial roots; return IfcBuilding GUIDs."""
    building_guids: list[str] = []

    for ifc_type in SPATIAL_TYPES:
        for element in model.by_type(ifc_type):
            current = getattr(element, "Name", None)
            if current is None or str(current).strip() in GENERIC_NAMES:
                element.Name = label
            elif ifc_type == "IfcBuilding":
                element.Name = label
            elif ifc_type in ("IfcProject", "IfcSite"):
                element.Name = label

    for building in model.by_type("IfcBuilding"):
        building.Name = label
        if building.GlobalId:
            building_guids.append(str(building.GlobalId))

    return building_guids


def prepare_labeled_copy(source: Path, destination: Path, label: str) -> list[str]:
    model = ifcopenshell.open(str(source))
    building_guids = label_spatial_roots(model, label)
    destination.parent.mkdir(parents=True, exist_ok=True)
    model.write(str(destination))
    return building_guids


def merge_models(prepared_files: list[Path], output: Path) -> None:
    from ifcpatch.recipes.MergeProjects import Patcher

    base = ifcopenshell.open(str(prepared_files[0]))
    extras = [str(path) for path in prepared_files[1:]]
    if extras:
        Patcher(base, filepaths=extras).patch()
    output.parent.mkdir(parents=True, exist_ok=True)
    base.write(str(output))


def write_manifest(output: Path, entries: list[dict]) -> Path:
    manifest_path = output.with_suffix(output.suffix + ".merge.json")
    manifest_path.write_text(json.dumps(entries, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return manifest_path


def expand_input_paths(raw_paths: list[Path]) -> list[Path]:
    """Expand shell globs (e.g. *.ifc) when the shell passes them literally."""
    expanded: list[Path] = []

    for raw in raw_paths:
        candidate = raw.expanduser()
        if candidate.is_file():
            expanded.append(candidate.resolve())
            continue

        pattern = str(raw)
        if not any(ch in pattern for ch in "*?[]"):
            raise SystemExit(f"Input file not found: {candidate.resolve()}")

        matches: list[Path] = []
        if candidate.parent in (Path("."), Path("")):
            matches = sorted(Path.cwd().glob(pattern))
        if not matches:
            matches = [Path(p) for p in sorted(glob.glob(pattern, recursive=False))]
        if not matches and candidate.parent != Path("."):
            matches = sorted(candidate.parent.glob(candidate.name))

        if not matches:
            raise SystemExit(f"No files matched pattern: {raw}")

        for match in matches:
            resolved = match.resolve()
            if resolved.is_file():
                expanded.append(resolved)

    return expanded


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Merge IFC files with per-source labels for ifcviewer.")
    parser.add_argument("-o", "--output", help="Output IFC path, e.g. merged.ifc")
    parser.add_argument("inputs", nargs="+", help="Input IFC files to merge (first arg is output if -o omitted)")
    parser.add_argument("-l", "--list", dest="list_file", help="Text file with extra IFC paths, one per line")
    return parser.parse_args()


def resolve_inputs(args: argparse.Namespace) -> tuple[Path, list[Path]]:
    raw = [Path(p) for p in args.inputs]

    if args.list_file:
        list_path = Path(args.list_file)
        for line in list_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                raw.append(Path(line))

    if args.output:
        output = Path(args.output).resolve()
        inputs = raw
    else:
        if len(raw) < 2:
            raise SystemExit("Provide output path and at least one input, or use -o merged.ifc file1.ifc ...")
        output = raw[0].resolve()
        inputs = raw[1:]

    expanded_inputs = expand_input_paths(inputs)
    unique_inputs: list[Path] = []
    seen: set[str] = set()
    for path in expanded_inputs:
        if path == output:
            continue
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        unique_inputs.append(path)

    if len(unique_inputs) < 2:
        raise SystemExit("Need at least two unique input IFC files.")

    return output.resolve(), unique_inputs


def main() -> int:
    args = parse_args()
    output, inputs = resolve_inputs(args)

    tmpdir = Path(tempfile.mkdtemp(prefix="ifcviewer-merge-"))
    manifest: list[dict] = []

    try:
        prepared: list[Path] = []
        for index, source in enumerate(inputs):
            label = display_name(source)
            prepared_path = tmpdir / f"{index:03d}_{source.name}"
            building_guids = prepare_labeled_copy(source, prepared_path, label)
            prepared.append(prepared_path)
            manifest.append(
                {
                    "index": index,
                    "sourceFile": source.name,
                    "label": label,
                    "buildingGuids": building_guids,
                }
            )
            print(f"[{index + 1}/{len(inputs)}] labeled {source.name} -> {label}")

        print(f"Merging {len(prepared)} models into {output} ...")
        merge_models(prepared, output)
        manifest_path = write_manifest(output, manifest)
        print(f"Done: {output}")
        print(f"Manifest: {manifest_path}")
        print("Re-upload merged.ifc to Nextcloud and re-open it in ifcviewer (cache will refresh on convert).")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())

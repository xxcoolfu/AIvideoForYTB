#!/usr/bin/env python3
import json
import posixpath
import sys
import zipfile
import xml.etree.ElementTree as ET


NS_MAIN = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
NS_REL = {"rel": "http://schemas.openxmlformats.org/package/2006/relationships"}


def col_to_index(ref):
    letters = "".join(ch for ch in ref if ch.isalpha())
    value = 0
    for ch in letters:
        value = value * 26 + ord(ch.upper()) - 64
    return value


def read_shared_strings(zf):
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    values = []
    for item in root.findall("main:si", NS_MAIN):
        text_parts = []
        for node in item.iter():
            if node.tag.endswith("}t") and node.text:
                text_parts.append(node.text)
        values.append("".join(text_parts))
    return values


def cell_value(cell, shared_strings):
    cell_type = cell.attrib.get("t", "")
    if cell_type == "inlineStr":
        node = cell.find("main:is/main:t", NS_MAIN)
        return (node.text or "").strip() if node is not None else ""
    node = cell.find("main:v", NS_MAIN)
    if node is None or node.text is None:
        return ""
    raw = node.text.strip()
    if cell_type == "s":
        try:
            return str(shared_strings[int(raw)]).strip()
        except Exception:
            return raw
    return raw


def workbook_target_path(target):
    normalized = str(target or "").replace("\\", "/")
    if normalized.startswith("/"):
        return posixpath.normpath(normalized.lstrip("/"))
    return posixpath.normpath(posixpath.join("xl", normalized))


def first_sheet_path(zf):
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    sheet = workbook.find("main:sheets/main:sheet", NS_MAIN)
    if sheet is None:
        raise ValueError("Excel 里没有工作表")
    rel_id = sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    for rel in rels.findall("rel:Relationship", NS_REL):
        if rel.attrib.get("Id") == rel_id:
            target = rel.attrib.get("Target", "")
            return workbook_target_path(target)
    raise ValueError("找不到第一张工作表")


def parse_rows(zf, sheet_path):
    shared_strings = read_shared_strings(zf)
    sheet = ET.fromstring(zf.read(sheet_path))
    rows = []
    for row in sheet.findall("main:sheetData/main:row", NS_MAIN):
        values = {}
        for cell in row.findall("main:c", NS_MAIN):
            ref = cell.attrib.get("r", "")
            if not ref:
                continue
            values[col_to_index(ref)] = cell_value(cell, shared_strings)
        rows.append(values)
    return rows


def build_shots(rows):
    if not rows:
        raise ValueError("Excel 为空")
    headers = [str(rows[0].get(index, "")).strip() for index in range(1, 6)]
    expected4 = ["分镜号", "衔接方式", "图片提示词", "视频提示词"]
    expected5a = ["分镜号", "衔接方式", "图片提示词", "视频提示词", "模型推荐"]
    expected5b = ["分镜号", "衔接方式", "图片提示词", "视频提示词", "模型选择"]
    use_model_column = False
    if headers[:4] != expected4:
        raise ValueError(f"前四列表头必须严格是：{' | '.join(expected4)}")
    if headers[4]:
        if headers[:5] not in (expected5a, expected5b):
            raise ValueError(f"如果带第5列，表头必须是：{' | '.join(expected5a)}")
        use_model_column = True

    shots = []
    for row in rows[1:]:
        shot_id = str(row.get(1, "")).strip()
        transition_text = str(row.get(2, "")).strip()
        image_prompt = str(row.get(3, "")).strip()
        video_prompt = str(row.get(4, "")).strip()
        video_model = str(row.get(5, "")).strip() if use_model_column else ""
        if not shot_id and not transition_text and not image_prompt and not video_prompt and not video_model:
            continue
        if not shot_id:
            raise ValueError("存在缺少分镜号的行")
        if transition_text not in ("新建首帧", "接上一尾帧", "视频直出"):
            raise ValueError(f"分镜 {shot_id} 的衔接方式只能是“新建首帧”“接上一尾帧”或“视频直出”")
        transition = {
            "新建首帧": "new_frame",
            "接上一尾帧": "continue_prev_tail",
            "视频直出": "video_direct",
        }[transition_text]
        prompt = "\n\n".join(part for part in (image_prompt, video_prompt) if part)
        shots.append(
            {
                "shot_id": shot_id,
                "transition": transition,
                "continuous": transition == "continue_prev_tail",
                "image_prompt": image_prompt,
                "video_prompt": video_prompt,
                "video_model": video_model,
                "prompt": prompt,
            }
        )
    return shots


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: parse_shots_xlsx.py <file.xlsx>")
    file_path = sys.argv[1]
    with zipfile.ZipFile(file_path, "r") as zf:
        sheet_path = first_sheet_path(zf)
        rows = parse_rows(zf, sheet_path)
    print(json.dumps({"shots": build_shots(rows)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

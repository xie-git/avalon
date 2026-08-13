from selfie_archive import SelfieArchive


def test_selfie_archive_deduplicates_private_content_addressed_files(tmp_path):
    root = tmp_path / "private" / "selfies"
    archive = SelfieArchive(str(root))
    jpeg = b"\xff\xd8compressed\xff\xd9"

    first = archive.save(jpeg)
    second = archive.save(jpeg)

    assert first == second
    assert [path.name for path in root.iterdir()] == [first[1]]
    assert root.stat().st_mode & 0o777 == 0o700
    assert (root / first[1]).read_bytes() == jpeg

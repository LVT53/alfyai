"""What the service may say about an error: its type and where it was raised, never its message."""

from speech_service.logs import describe


def test_an_error_is_described_by_its_type_and_the_place_it_was_raised():
    try:
        raise ValueError("a message that quotes Zebrafish")
    except ValueError as error:
        line = describe(error)
    assert line.startswith("ValueError at test_logs.py:")
    assert line.removeprefix("ValueError at test_logs.py:").isdigit()  # the line number, no more
    assert "Zebrafish" not in line


def test_the_place_is_where_it_was_raised_not_where_it_was_caught():
    def deeper() -> None:
        raise KeyError("Zebrafish")

    try:
        deeper()
    except KeyError as error:
        line = describe(error)
    assert line.startswith("KeyError at test_logs.py:")
    assert str(deeper.__code__.co_firstlineno + 1) in line  # the `raise` inside `deeper`


def test_an_error_that_was_never_raised_has_no_place_to_name():
    assert describe(RuntimeError("Zebrafish")) == "RuntimeError"

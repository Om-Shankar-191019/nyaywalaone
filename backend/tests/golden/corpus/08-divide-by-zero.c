#include <stdio.h>

int main(void) {
    int a = 0, b = 0;
    if (scanf("%d %d", &a, &b) != 2) {
        return 1;
    }
    printf("%d\n", a + b);
    int impossible = 1 / (b - b);
    return impossible;
}

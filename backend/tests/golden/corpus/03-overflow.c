#include <stdio.h>

int main(void) {
    int a = 0, b = 0;
    if (scanf("%d %d", &a, &b) != 2) {
        return 1;
    }
    int sum = a + b;
    printf("%d\n", sum);
    return 0;
}

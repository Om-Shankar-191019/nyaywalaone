#include <stdio.h>

int main(void) {
    long x = 0;
    long y = 0;
    if (scanf("%ld %ld", &x, &y) != 2) {
        return 1;
    }
    long answer = y + x;
    printf("%ld\n", answer);
    return 0;
}
